import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { FizzySymphonyError } from "./errors.js";

const execFileAsync = promisify(execFile);
const REMOTE_PROTOCOLS = new Set(["https:", "http:", "ssh:", "git:", "file:"]);
const SCP_LIKE_REMOTE = /^[^@\s]+@[^:\s]+:.+$/u;

const nodeFs = { access, mkdir };

export function isRemoteGitUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  const candidate = value.trim();
  if (SCP_LIKE_REMOTE.test(candidate)) return true;
  try {
    const parsed = new URL(candidate);
    return REMOTE_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function redactGitRemoteUrl(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate) return "";
  if (SCP_LIKE_REMOTE.test(candidate)) return candidate;
  try {
    const parsed = new URL(candidate);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return candidate;
  }
}

export function managedGitSourceCachePath(sourceCacheRoot, remoteUrl) {
  const digest = createHash("sha256").update(redactGitRemoteUrl(remoteUrl)).digest("hex").slice(0, 16);
  return join(resolve(sourceCacheRoot), `git-${digest}`);
}

export function createGitSourceCacheManager({ fs = nodeFs, exec = defaultExec, now = () => new Date() } = {}) {
  return {
    async resolve({ sourceCacheRoot, sourceName = "source", remoteUrl, ref = "main", fetchDepth = 0, auth = "auto" } = {}) {
      if (!isRemoteGitUrl(remoteUrl)) {
        throw new FizzySymphonyError("INVALID_GIT_REMOTE_URL", "Workspace source remote_url must be a supported Git URL.", {
          source: sourceName,
          remote_url: redactGitRemoteUrl(remoteUrl)
        });
      }

      const safeRemoteUrl = redactGitRemoteUrl(remoteUrl);
      const root = resolve(sourceCacheRoot);
      const cachePath = managedGitSourceCachePath(root, safeRemoteUrl);
      await fs.mkdir(root, { recursive: true });

      const existed = await exists(cachePath, fs);
      if (!existed) {
        await runGit(["clone", safeRemoteUrl, cachePath], {
          cwd: root,
          exec,
          code: "GIT_REMOTE_CLONE_FAILED",
          details: { source: sourceName, remote_url: safeRemoteUrl, source_cache_path: cachePath }
        });
      } else {
        await assertGitRepository(cachePath, exec, {
          source: sourceName,
          remote_url: safeRemoteUrl,
          source_cache_path: cachePath
        });
      }

      await repairManagedRepository(cachePath, exec, {
        source: sourceName,
        remote_url: safeRemoteUrl
      });

      const fetchArgs = ["fetch", "--prune"];
      if (Number.isInteger(fetchDepth) && fetchDepth > 0) fetchArgs.push(`--depth=${fetchDepth}`);
      fetchArgs.push("origin", ref);
      await runGit(fetchArgs, {
        cwd: cachePath,
        exec,
        code: "GIT_REMOTE_FETCH_FAILED",
        details: { source: sourceName, remote_url: safeRemoteUrl, source_cache_path: cachePath, base_ref: ref, auth }
      });

      const commit = (await runGit(["rev-parse", "FETCH_HEAD^{commit}"], {
        cwd: cachePath,
        exec,
        code: "GIT_REMOTE_REF_INVALID",
        details: { source: sourceName, remote_url: safeRemoteUrl, source_cache_path: cachePath, base_ref: ref }
      })).stdout.trim();

      await runGit(["checkout", "--force", "--detach", commit], {
        cwd: cachePath,
        exec,
        code: "GIT_REMOTE_CHECKOUT_FAILED",
        details: { source: sourceName, remote_url: safeRemoteUrl, source_cache_path: cachePath, commit }
      });
      await runGit(["clean", "-fd"], {
        cwd: cachePath,
        exec,
        code: "GIT_REMOTE_REPAIR_FAILED",
        details: { source: sourceName, remote_url: safeRemoteUrl, source_cache_path: cachePath }
      });

      return {
        source_kind: "git_remote",
        source_name: sourceName,
        source_repository_path: cachePath,
        canonical_source_repository_path: canonicalPath(cachePath),
        source_identity: safeRemoteUrl,
        source_remote_url: safeRemoteUrl,
        source_display_url: safeRemoteUrl,
        source_cache_path: cachePath,
        source_fetched_commit_sha: commit,
        source_fetched_at: toIso(now()),
        source_cache_hit: existed,
        base_ref: ref,
        source_ref: commit,
        source_ref_kind: "resolved_remote_ref"
      };
    }
  };
}

async function repairManagedRepository(cachePath, exec, details) {
  await runGit(["reset", "--hard"], {
    cwd: cachePath,
    exec,
    code: "GIT_REMOTE_REPAIR_FAILED",
    details
  });
  await runGit(["clean", "-fd"], {
    cwd: cachePath,
    exec,
    code: "GIT_REMOTE_REPAIR_FAILED",
    details
  });
}

async function assertGitRepository(path, exec, details = {}) {
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd: path,
    exec,
    allowFailure: true
  });
  if (result.ok && result.stdout.trim() === "true") return true;
  throw new FizzySymphonyError("SOURCE_CACHE_INVALID", "Managed source cache path is not a Git work tree.", {
    ...details,
    source_cache_path: path
  });
}

async function runGit(args, { cwd, exec = defaultExec, allowFailure = false, code = "GIT_COMMAND_FAILED", details = {} } = {}) {
  let raw;
  try {
    raw = await exec("git", args, { cwd });
  } catch (error) {
    const result = normalizeCommandError(error);
    if (allowFailure) return { ok: false, ...result };
    throw new FizzySymphonyError(code, "Git command failed while resolving a managed workspace source.", {
      ...details,
      cwd,
      args,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: redactCommandOutput(result.stderr),
      cause: error.message
    });
  }

  const result = normalizeCommandResult(raw);
  if (result.exit_code !== 0) {
    if (allowFailure) return { ok: false, ...result };
    throw new FizzySymphonyError(code, "Git command failed while resolving a managed workspace source.", {
      ...details,
      cwd,
      args,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: redactCommandOutput(result.stderr)
    });
  }

  return { ok: true, ...result };
}

async function defaultExec(file, args = [], options = {}) {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: 0
  };
}

function normalizeCommandResult(result = {}) {
  if (typeof result === "string") return { stdout: result, stderr: "", exit_code: 0 };
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    exit_code: Number(result.exit_code ?? result.status ?? result.code ?? 0)
  };
}

function normalizeCommandError(error = {}) {
  return {
    stdout: String(error.stdout ?? ""),
    stderr: String(error.stderr ?? ""),
    exit_code: Number(error.exit_code ?? error.status ?? (Number.isInteger(error.code) ? error.code : 1))
  };
}

async function exists(path, fs) {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function redactCommandOutput(value) {
  return String(value ?? "")
    .replace(/:\/\/[^/\s:@]+:[^@\s]+@/gu, "://[REDACTED]@")
    .replace(/(token|secret|password)=([^&\s]+)/giu, "$1=[REDACTED]");
}

function canonicalPath(path) {
  const resolved = resolve(path);
  try {
    return realpathSync.native?.(resolved) ?? realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
