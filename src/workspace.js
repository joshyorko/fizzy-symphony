import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { evaluateCleanupEligibility } from "./completion.js";
import { FizzySymphonyError } from "./errors.js";
import { createGitSourceCacheManager } from "./git-source-cache.js";
import { loadWorkflow } from "./workflow.js";

const GUARD_FILE_VERSION = 1;
const GUARD_FILE_NAME = ".fizzy-symphony-workspace-guard.json";
const METADATA_MARKER = "fizzy-symphony:workspace-metadata:v1";
const GUARD_MARKER = "fizzy-symphony:workspace-guard:v1";
const SUPPORTED_ISOLATION_STRATEGIES = new Set(["git_worktree"]);

const execFileAsync = promisify(execFile);
const nodeFs = { access, mkdir, readdir, readFile, realpath, rm, writeFile };

export function resolveWorkspaceIdentity({ config, route, card, workspaceName } = {}) {
  return resolveWorkspaceIdentityFromSource({ config, route, card, workspaceName });
}

function resolveWorkspaceIdentityFromSource({ config, route, card, workspaceName, source } = {}) {
  const name = workspaceName ?? route?.workspace;
  const registry = config?.workspaces?.registry ?? {};
  const workspace = registry[name];

  if (!workspace) {
    throw new FizzySymphonyError("UNKNOWN_WORKSPACE", "Unknown named workspace; dispatch cannot fall back.", {
      workspace: name,
      available_workspaces: Object.keys(registry).sort()
    });
  }

  const boardId = route?.board_id ?? card?.board_id ?? card?.board?.id;
  const cardId = card?.id;
  const cardNumber = card?.number;
  requireIdentityField("board_id", boardId);
  requireIdentityField("card_id", cardId);
  requireIdentityField("card_number", cardNumber);
  requireIdentityField("route_id", route?.id);
  requireIdentityField("route_fingerprint", route?.fingerprint);

  if (workspace.source && !source) {
    throw new FizzySymphonyError("WORKSPACE_SOURCE_RESOLUTION_REQUIRED", "Remote workspace sources must be resolved through the workspace manager.", {
      workspace: name,
      source: workspace.source
    });
  }

  const resolvedSource = source ?? resolveLocalWorkspaceSource({ config, route, workspace, workspaceName: name });
  const sourceRepositoryPath = resolvedSource.source_repository_path;
  requireIdentityField("source_repository_path", sourceRepositoryPath);

  const canonicalSourceRepositoryPath = resolvedSource.canonical_source_repository_path ?? canonicalPath(sourceRepositoryPath);
  const isolationStrategy = workspace.isolation ?? config?.workspaces?.default_isolation ?? "git_worktree";
  if (!SUPPORTED_ISOLATION_STRATEGIES.has(isolationStrategy)) {
    throw new FizzySymphonyError("UNSUPPORTED_WORKSPACE_ISOLATION", "Workspace isolation strategy is not supported.", {
      workspace: name,
      isolation_strategy: isolationStrategy,
      supported: [...SUPPORTED_ISOLATION_STRATEGIES].sort()
    });
  }

  const sourceIdentity = resolvedSource.source_identity ?? canonicalSourceRepositoryPath;
  const repoKey = shortDigest(`${sourceIdentity}@${resolvedSource.source_ref}`);
  const key = buildWorkspaceKey({
    board_id: boardId,
    card_id: cardId,
    card_number: cardNumber,
    workspace_name: name,
    repo_key: repoKey
  });
  const workspaceRoot = workspace.worktree_root ?? config?.workspaces?.root;
  const path = workspacePathFromRoot(workspaceRoot, key, config?.safety?.allowed_roots);

  const identityBase = omitUndefined({
    board_id: boardId,
    card_id: cardId,
    card_number: cardNumber,
    workspace_name: name,
    source_repository_path: sourceRepositoryPath,
    canonical_source_repository_path: canonicalSourceRepositoryPath,
    source_identity: sourceIdentity,
    source_kind: resolvedSource.source_kind,
    source_name: resolvedSource.source_name,
    source_remote_url: resolvedSource.source_remote_url,
    source_display_url: resolvedSource.source_display_url,
    source_cache_path: resolvedSource.source_cache_path,
    source_fetched_commit_sha: resolvedSource.source_fetched_commit_sha,
    source_fetched_at: resolvedSource.source_fetched_at,
    base_ref: resolvedSource.base_ref,
    source_snapshot_id: resolvedSource.source_snapshot_id,
    source_ref: resolvedSource.source_ref,
    source_ref_kind: resolvedSource.source_ref_kind,
    isolation_strategy: isolationStrategy,
    repo_key: repoKey,
    workspace_key: key
  });

  return {
    ...identityBase,
    route_id: route?.id,
    route_fingerprint: route?.fingerprint,
    branch_prefix: workspace.branch_prefix ?? "fizzy",
    workspace_root: resolve(workspaceRoot),
    workspace_path: path,
    workspace_identity_digest: digest(identityBase)
  };
}

export function workspaceKey(identity) {
  const sourceIdentity = identity.source_identity ?? identity.canonical_source_repository_path;
  const repoKey = identity.repo_key ?? shortDigest(`${sourceIdentity}@${identity.source_ref}`);
  return buildWorkspaceKey({ ...identity, repo_key: repoKey });
}

export function workspacePath(config, key) {
  return workspacePathFromRoot(config?.workspaces?.root, key, config?.safety?.allowed_roots);
}

export function branchName(identity, options = {}) {
  const prefix = sanitizeBranchPrefix(options.prefix ?? identity.branch_prefix ?? "fizzy");
  const digestValue = identity.workspace_identity_digest ?? digest(identityDigestInput(identity));
  const shortIdentity = String(digestValue).replace(/^sha256:/u, "").slice(0, 12);
  const shortCardId = sanitize(identity.card_id).slice(0, 12);
  const name = [
    sanitize(identity.board_id),
    "card",
    sanitize(identity.card_number),
    shortCardId,
    sanitize(identity.workspace_name),
    shortIdentity
  ].join("-");

  return `${prefix}/${name}`;
}

export function createWorkspaceManager({ fs = nodeFs, exec = defaultExec, sourceCache = createGitSourceCacheManager({ fs, exec }) } = {}) {
  return {
    async resolveIdentity({ config, route, card, workspaceName } = {}) {
      const source = await resolveWorkspaceSource({ config, route, workspaceName, sourceCache });
      return resolveWorkspaceIdentityFromSource({ config, route, card, workspaceName, source });
    },
    preflight({ config, identity, workspace } = {}) {
      return preflightWorkspaceSource({ config, identity: identity ?? workspace, fs, exec });
    },
    prepare({ config, identity, workspace, claim = {}, now = new Date() } = {}) {
      return prepareWorkspace({
        config,
        identity: identity ?? workspace,
        fs,
        exec,
        metadata: {
          run_attempt_id: claim.attempt_id ?? claim.attemptId,
          run_id: claim.run_id ?? claim.runId,
          claim_id: claim.id ?? claim.claim_id,
          created_at: toIso(now)
        }
      });
    },
    preserve({ run = {}, reason, finalStatus } = {}) {
      return {
        status: "preserved",
        reason,
        final_status: finalStatus,
        workspace_path: run.workspace_path ?? run.workspace?.path ?? run.workspace?.workspace_path,
        workspace_key: run.workspace_key ?? run.workspace?.key ?? run.workspace?.workspace_key
      };
    },
    cleanup(options = {}) {
      return cleanupWorkspace({ ...options, fs, exec });
    }
  };
}

export async function preflightWorkspaceSource({ config, identity, fs = nodeFs, exec = defaultExec } = {}) {
  if (!identity) return { status: "skipped", reason: "workspace_identity_missing" };
  if (identity.isolation_strategy !== "git_worktree") {
    return { status: "skipped", reason: "unsupported_isolation_strategy", isolation_strategy: identity.isolation_strategy };
  }

  const sourceRepositoryPath = resolve(identity.canonical_source_repository_path ?? identity.source_repository_path);
  await assertGitRepository(sourceRepositoryPath, exec);
  await assertGitRef(sourceRepositoryPath, identity.source_ref, exec);

  const workspace = workspaceConfig(config, identity.workspace_name);
  const sourceStatus = await gitStatus({
    cwd: sourceRepositoryPath,
    exec,
    ignoredPaths: config?.safety?.ignored_dirty_paths ?? []
  });
  const snapshotPolicy = config?.safety?.dirty_source_repo_policy === "snapshot";
  const policyRequiresClean = !snapshotPolicy && (
    workspace?.require_clean_source === true ||
    config?.safety?.dirty_source_repo_policy === "fail"
  );

  if (policyRequiresClean && !sourceStatus.clean) {
    throw new FizzySymphonyError(
      "WORKSPACE_SOURCE_DIRTY",
      "Source repository has local changes and the workspace policy requires a clean source.",
      {
        preserve_workspace: true,
        source_repository_path: sourceRepositoryPath,
        dirty_paths: sourceStatus.paths
      }
    );
  }

  return {
    status: "ok",
    source_repository_path: sourceRepositoryPath,
    source_ref: identity.source_ref,
    clean: sourceStatus.clean,
    dirty_paths: sourceStatus.paths,
    source_remote_url: identity.source_remote_url,
    source_display_url: identity.source_display_url,
    source_cache_path: identity.source_cache_path
  };
}

export async function prepareWorkspace({ config, identity, metadata = {}, fs = nodeFs, exec = defaultExec } = {}) {
  const key = identity.workspace_key ?? workspaceKey(identity);
  const path = identity.workspace_path ?? workspacePathFromRoot(
    identity.workspace_root ?? config?.workspaces?.root,
    key,
    config?.safety?.allowed_roots
  );
  const workspaceRoot = identity.workspace_root ?? config?.workspaces?.root;
  assertPathInsideRoot(path, workspaceRoot, "WORKSPACE_PATH_ESCAPE", { key });
  assertPathInsideAllowedRoots(path, config?.safety?.allowed_roots);

  requireIdentityField("metadata_root", config?.workspaces?.metadata_root);
  const metadataRoot = resolve(config.workspaces.metadata_root);
  const metadataPath = workspacePathFromRoot(metadataRoot, `${key}.json`, config?.safety?.allowed_roots);
  const guardPath = join(path, GUARD_FILE_NAME);
  const existing = await readJsonIfExists(metadataPath, fs);
  if (existing) validateExistingWorkspaceMetadata(existing, identity);

  const branch = branchName(identity);
  let created = false;
  let sourceHead;

  if (identity.isolation_strategy === "git_worktree") {
    const preflight = await preflightWorkspaceSource({ config, identity, fs, exec });
    sourceHead = await gitCommit(resolve(identity.canonical_source_repository_path), identity.source_ref, exec);
    const pathExists = await exists(path, fs);
    if (!pathExists) {
      await fs.mkdir(dirname(path), { recursive: true });
      await addGitWorktree({
        sourceRepositoryPath: preflight.source_repository_path,
        workspacePath: path,
        branch,
        sourceRef: identity.source_ref,
        exec
      });
      created = true;
    } else {
      if (!existing) {
        throw new FizzySymphonyError(
          "WORKSPACE_METADATA_MISSING",
          "Existing workspace path is missing daemon metadata; preserving workspace.",
          {
            preserve_workspace: true,
            workspace_key: key,
            workspace_path: path,
            metadata_path: metadataPath
          }
        );
      }
      await validateReusableWorktree({
        sourceRepositoryPath: preflight.source_repository_path,
        workspacePath: path,
        branch,
        metadata: existing,
        metadataPath,
        guardPath,
        fs,
        exec
      });
    }
    await excludeGuardFile(path, fs, exec);
  } else {
    await fs.mkdir(path, { recursive: true });
    created = !existing;
  }

  await fs.mkdir(metadataRoot, { recursive: true });
  const fullMetadata = buildWorkspaceMetadata({
    config,
    identity,
    metadata: {
      ...metadata,
      branch_name: branch,
      source_head: sourceHead
    },
    key,
    path
  });
  const guard = buildGuard({ identity, key, metadataPath });

  await fs.writeFile(guardPath, `${JSON.stringify(guard, null, 2)}\n`, "utf8");
  await fs.writeFile(metadataPath, `${JSON.stringify(fullMetadata, null, 2)}\n`, "utf8");

  const workflow = await loadWorkflowForHooks({ config, identity, workspacePath: path, fs });
  const hookResults = [];
  if (created) {
    const afterCreate = await runWorkflowHook({ workflow, hook: "after_create", cwd: path, exec });
    if (afterCreate) hookResults.push(afterCreate);
  }
  const beforeRun = await runWorkflowHook({ workflow, hook: "before_run", cwd: path, exec });
  if (beforeRun) hookResults.push(beforeRun);

  return {
    key,
    path,
    workspace_key: key,
    workspace_path: path,
    guard_path: guardPath,
    metadata_path: metadataPath,
    source_repo: identity.source_repository_path,
    sourceRepo: identity.source_repository_path,
    branch_name: branch,
    identity_digest: identity.workspace_identity_digest,
    workspace_identity_digest: identity.workspace_identity_digest,
    created,
    hooks: hookResults,
    guard,
    metadata: fullMetadata
  };
}

export async function cleanupWorkspace({
  config = {},
  workspace = {},
  proof,
  result,
  resultComment,
  completionMarker,
  completionPolicyResult,
  claimRelease,
  fs = nodeFs,
  exec = defaultExec
} = {}) {
  const eligibility = evaluateCleanupEligibility({
    config,
    workspace,
    proof,
    result,
    resultComment,
    completionMarker,
    completionPolicyResult,
    claimRelease
  });
  if (eligibility.action !== "eligible") return eligibility;

  const workspacePath = workspace.path ?? workspace.workspace_path;
  const workspaceKeyValue = workspace.key ?? workspace.workspace_key;
  if (!workspacePath) return preserve("workspace_path_missing");

  const proofCheck = await verifyDurableProofFile({ proof, workspacePath, fs });
  if (!proofCheck.ok) return preserve(proofCheck.reason, proofCheck.details);

  const metadataPath = workspace.metadata_path ??
    (workspaceKeyValue && config.workspaces?.metadata_root
      ? workspacePathFromRoot(resolve(config.workspaces.metadata_root), `${workspaceKeyValue}.json`, config?.safety?.allowed_roots)
      : null);
  if (!metadataPath) return preserve("workspace_metadata_path_missing");

  const metadata = await readJsonIfExists(metadataPath, fs);
  if (!metadata) return preserve("workspace_metadata_missing");

  const guardPath = workspace.guard_path ?? join(workspacePath, GUARD_FILE_NAME);
  const guardResult = await validateGuardForMetadata({ metadata, metadataPath, guardPath, fs });
  if (!guardResult.ok) return preserve(guardResult.code, guardResult.details);

  const sourceRepositoryPath = resolve(metadata.canonical_source_repository_path ?? metadata.source_repository_path);
  const filesystem = await inspectWorktreeForCleanup({
    workspacePath,
    metadata,
    exec
  });
  if (!filesystem.clean) return preserve("worktree_dirty", { filesystem_evidence: filesystem });
  if (filesystem.unpushed_commits.length > 0) return preserve("worktree_unpushed", { filesystem_evidence: filesystem });
  if (filesystem.branch_merged === false) return preserve("worktree_unmerged", { filesystem_evidence: filesystem });

  const workflow = await loadWorkflowForHooks({ config, metadata, workspacePath, fs });
  try {
    await runWorkflowHook({ workflow, hook: "before_remove", cwd: workspacePath, exec });
  } catch (error) {
    return preserve("before_remove_hook_failed", { error: normalizeError(error) });
  }

  const postHookFilesystem = await inspectWorktreeForCleanup({
    workspacePath,
    metadata,
    exec
  });
  if (!postHookFilesystem.clean) {
    return preserve("worktree_dirty", { filesystem_evidence: postHookFilesystem });
  }

  await runGit(["worktree", "remove", workspacePath], { cwd: sourceRepositoryPath, exec });
  await fs.rm?.(metadataPath, { force: true });
  return {
    action: "removed",
    status: "cleanup_completed",
    reason: "guards_passed",
    method: "git_worktree_remove",
    force: false,
    workspace_key: workspaceKeyValue,
    workspace_path: workspacePath,
    filesystem_evidence: postHookFilesystem
  };
}

export async function scanWorkspaceMetadata({ config, fs = nodeFs } = {}) {
  const metadataRoot = config?.workspaces?.metadata_root;
  const report = {
    workspaces: [],
    preserved_workspaces: [],
    warnings: [],
    errors: []
  };

  if (!metadataRoot) return report;

  let entries;
  try {
    entries = await fs.readdir(metadataRoot);
  } catch (error) {
    if (error.code === "ENOENT") return report;
    throw error;
  }

  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const metadataPath = join(resolve(metadataRoot), entry);
    const metadataResult = await readJsonForScan(metadataPath, fs, "WORKSPACE_METADATA_INVALID");
    if (!metadataResult.ok) {
      const preserved = workspacePreservation({
        code: "WORKSPACE_METADATA_INVALID",
        message: "Workspace metadata is not valid JSON.",
        metadata_path: metadataPath,
        details: { cause: metadataResult.error.message }
      });
      report.preserved_workspaces.push(preserved);
      report.warnings.push(preserved);
      continue;
    }

    const metadata = metadataResult.value;
    const workspace = {
      workspace_key: metadata.workspace_key,
      workspace_path: metadata.workspace_path,
      metadata_path: metadataPath,
      metadata
    };
    report.workspaces.push(workspace);

    const missing = ["workspace_key", "workspace_path", "workspace_identity_digest", "route_fingerprint"].filter((field) => !metadata?.[field]);
    if (metadata?.marker !== METADATA_MARKER || missing.length > 0) {
      const preserved = workspacePreservation({
        code: "WORKSPACE_METADATA_INVALID",
        message: "Workspace metadata is missing required identity fields.",
        metadata_path: metadataPath,
        workspace_key: metadata?.workspace_key,
        workspace_path: metadata?.workspace_path,
        details: { missing, marker: metadata?.marker }
      });
      report.preserved_workspaces.push(preserved);
      report.warnings.push(preserved);
      continue;
    }

    const guardPath = join(metadata.workspace_path, GUARD_FILE_NAME);
    const guardResult = await readJsonForScan(guardPath, fs, "WORKSPACE_GUARD_INVALID");
    if (!guardResult.ok) {
      const code = guardResult.missing ? "WORKSPACE_GUARD_MISSING" : "WORKSPACE_GUARD_INVALID";
      const preserved = workspacePreservation({
        code,
        message: guardResult.missing ? "Workspace guard file is missing." : "Workspace guard file is not valid JSON.",
        metadata_path: metadataPath,
        guard_path: guardPath,
        workspace_key: metadata.workspace_key,
        workspace_path: metadata.workspace_path,
        details: guardResult.missing ? {} : { cause: guardResult.error.message }
      });
      report.preserved_workspaces.push(preserved);
      report.warnings.push(preserved);
      continue;
    }

    const mismatches = guardMismatches(guardResult.value, metadata, metadataPath);
    if (guardResult.value?.guard !== GUARD_MARKER) mismatches.push("guard");
    if (mismatches.length > 0) {
      const preserved = workspacePreservation({
        code: "WORKSPACE_METADATA_GUARD_MISMATCH",
        message: "Workspace guard does not match workspace metadata.",
        metadata_path: metadataPath,
        guard_path: guardPath,
        workspace_key: metadata.workspace_key,
        workspace_path: metadata.workspace_path,
        details: { mismatches }
      });
      report.preserved_workspaces.push(preserved);
      report.warnings.push(preserved);
    }
  }

  return report;
}

export function validateExistingWorkspaceMetadata(existing, identity) {
  const expected = {
    workspace_identity_digest: identity.workspace_identity_digest,
    route_fingerprint: identity.route_fingerprint,
    canonical_source_repository_path: identity.canonical_source_repository_path,
    source_identity: identity.source_identity,
    board_id: identity.board_id,
    card_id: identity.card_id,
    card_number: identity.card_number,
    workspace_name: identity.workspace_name,
    workspace_key: identity.workspace_key ?? workspaceKey(identity),
    source_ref: identity.source_ref,
    isolation_strategy: identity.isolation_strategy
  };
  const mismatches = [];

  for (const [field, value] of Object.entries(expected)) {
    if (existing?.[field] !== value) mismatches.push(field);
  }

  if (mismatches.length > 0) {
    throw new FizzySymphonyError(
      "WORKSPACE_METADATA_MISMATCH",
      "Existing workspace metadata does not match this dispatch; preserving workspace.",
      {
        preserve_workspace: true,
        mismatches,
        workspace_key: expected.workspace_key,
        workspace_path: identity.workspace_path,
        route_fingerprint: identity.route_fingerprint
      }
    );
  }

  return true;
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

async function runGit(args, { cwd, exec = defaultExec, allowFailure = false } = {}) {
  let raw;
  try {
    raw = await exec("git", args, { cwd });
  } catch (error) {
    const result = normalizeCommandError(error);
    if (allowFailure) return { ok: false, ...result };
    throw gitCommandFailed({ cwd, args, result, cause: error.message });
  }

  const result = normalizeCommandResult(raw);
  if (result.exit_code !== 0) {
    if (allowFailure) return { ok: false, ...result };
    throw gitCommandFailed({ cwd, args, result });
  }

  return { ok: true, ...result };
}

async function runCommand(argv, { cwd, exec = defaultExec } = {}) {
  const [file, ...args] = argv;
  let raw;
  try {
    raw = await exec(file, args, { cwd });
  } catch (error) {
    const result = normalizeCommandError(error);
    throw hookCommandFailed({ cwd, argv, result, cause: error.message });
  }

  const result = normalizeCommandResult(raw);
  if (result.exit_code !== 0) throw hookCommandFailed({ cwd, argv, result });
  return result;
}

function gitCommandFailed({ cwd, args, result, cause }) {
  return new FizzySymphonyError("GIT_COMMAND_FAILED", "Git command failed.", {
    cwd,
    args,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    cause
  });
}

function hookCommandFailed({ cwd, argv, result, cause }) {
  return new FizzySymphonyError("WORKSPACE_HOOK_FAILED", "Workspace lifecycle hook failed.", {
    cwd,
    argv,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    cause
  });
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
    exit_code: Number(error.exit_code ?? error.status ?? (Number.isInteger(error.code) ? error.code : 1)),
    code: error.code,
    message: error.message ?? String(error)
  };
}

async function assertGitRepository(sourceRepositoryPath, exec) {
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd: sourceRepositoryPath,
    exec,
    allowFailure: true
  });
  if (!result.ok || result.stdout.trim() !== "true") {
    throw new FizzySymphonyError("WORKSPACE_SOURCE_REPO_INVALID", "Workspace source repository is not a git work tree.", {
      source_repository_path: sourceRepositoryPath,
      preserve_workspace: true
    });
  }
}

async function assertGitRef(sourceRepositoryPath, sourceRef, exec) {
  const result = await runGit(["cat-file", "-e", `${sourceRef}^{commit}`], {
    cwd: sourceRepositoryPath,
    exec,
    allowFailure: true
  });
  if (!result.ok) {
    throw new FizzySymphonyError("WORKSPACE_SOURCE_REF_INVALID", "Workspace source ref does not resolve to a commit.", {
      source_repository_path: sourceRepositoryPath,
      source_ref: sourceRef,
      preserve_workspace: true
    });
  }
}

async function gitCommit(sourceRepositoryPath, sourceRef, exec) {
  const result = await runGit(["rev-parse", `${sourceRef}^{commit}`], { cwd: sourceRepositoryPath, exec });
  return result.stdout.trim();
}

async function gitStatus({ cwd, exec, ignoredPaths = [GUARD_FILE_NAME] }) {
  const result = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd, exec });
  const entries = parsePorcelainStatus(result.stdout).filter((entry) => !matchesIgnoredPath(entry.path, ignoredPaths));
  return {
    clean: entries.length === 0,
    paths: entries.map((entry) => entry.path),
    entries
  };
}

function matchesIgnoredPath(path, ignoredPaths = []) {
  const normalizedPath = normalizeStatusPath(path);
  return (ignoredPaths ?? []).some((ignoredPath) => {
    const pattern = normalizeStatusPath(ignoredPath);
    if (!pattern) return false;
    if (pattern.endsWith("/")) return normalizedPath.startsWith(pattern);
    return normalizedPath === pattern;
  });
}

function normalizeStatusPath(path) {
  return String(path ?? "").replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function parsePorcelainStatus(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
      return { status, path };
    });
}

async function addGitWorktree({ sourceRepositoryPath, workspacePath, branch, sourceRef, exec }) {
  const branchExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: sourceRepositoryPath,
    exec,
    allowFailure: true
  });
  const args = branchExists.ok
    ? ["worktree", "add", workspacePath, branch]
    : ["worktree", "add", "-b", branch, workspacePath, sourceRef];
  try {
    await runGit(args, { cwd: sourceRepositoryPath, exec });
  } catch (error) {
    throw new FizzySymphonyError("WORKSPACE_WORKTREE_CREATE_FAILED", "Unable to create git worktree.", {
      preserve_workspace: true,
      source_repository_path: sourceRepositoryPath,
      workspace_path: workspacePath,
      branch,
      source_ref: sourceRef,
      cause: error.message,
      cause_details: error.details ?? {}
    });
  }
}

async function validateReusableWorktree({
  sourceRepositoryPath,
  workspacePath,
  branch,
  metadata,
  metadataPath,
  guardPath,
  fs,
  exec
}) {
  const guardResult = await validateGuardForMetadata({ metadata, metadataPath, guardPath, fs });
  if (!guardResult.ok) {
    throw new FizzySymphonyError(guardResult.code, "Existing workspace guard is missing or does not match metadata.", {
      preserve_workspace: true,
      workspace_path: workspacePath,
      metadata_path: metadataPath,
      guard_path: guardPath,
      ...guardResult.details
    });
  }

  const worktreeRegistered = await registeredWorktreePath(sourceRepositoryPath, workspacePath, exec);
  if (!worktreeRegistered) {
    throw new FizzySymphonyError("WORKSPACE_WORKTREE_UNREGISTERED", "Existing workspace path is not a registered git worktree for the source repository.", {
      preserve_workspace: true,
      source_repository_path: sourceRepositoryPath,
      workspace_path: workspacePath
    });
  }

  const actualBranch = (await runGit(["branch", "--show-current"], { cwd: workspacePath, exec })).stdout.trim();
  if (actualBranch !== branch) {
    throw new FizzySymphonyError("WORKSPACE_BRANCH_MISMATCH", "Existing workspace branch does not match deterministic workspace branch.", {
      preserve_workspace: true,
      workspace_path: workspacePath,
      expected_branch: branch,
      actual_branch: actualBranch
    });
  }

  const status = await gitStatus({ cwd: workspacePath, exec });
  if (!status.clean) {
    throw new FizzySymphonyError("WORKSPACE_WORKTREE_DIRTY", "Existing workspace has local changes; preserving workspace.", {
      preserve_workspace: true,
      workspace_path: workspacePath,
      dirty_paths: status.paths
    });
  }
}

async function registeredWorktreePath(sourceRepositoryPath, workspacePath, exec) {
  const result = await runGit(["worktree", "list", "--porcelain"], { cwd: sourceRepositoryPath, exec });
  const expected = resolve(workspacePath);
  return result.stdout
    .split(/\r?\n/u)
    .some((line) => line.startsWith("worktree ") && resolve(line.slice("worktree ".length)) === expected);
}

async function excludeGuardFile(workspacePath, fs, exec) {
  const result = await runGit(["rev-parse", "--git-path", "info/exclude"], { cwd: workspacePath, exec });
  const excludePath = result.stdout.trim();
  let content = "";
  try {
    content = await fs.readFile(excludePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const line = `/${GUARD_FILE_NAME}`;
  if (content.split(/\r?\n/u).includes(line)) return;
  const next = content.endsWith("\n") || content === "" ? `${content}${line}\n` : `${content}\n${line}\n`;
  await fs.writeFile(excludePath, next, "utf8");
}

async function loadWorkflowForHooks({ config, identity, metadata, workspacePath, fs }) {
  const workspaceName = identity?.workspace_name ?? metadata?.workspace_name;
  const sourceRepo = identity?.canonical_source_repository_path ?? metadata?.canonical_source_repository_path;
  const workspace = {
    sourceRepo,
    source_repo: sourceRepo,
    path: workspacePath,
    workspace_path: workspacePath,
    config: workspaceConfig(config, workspaceName)
  };
  try {
    return await loadWorkflow({ workspace, config, fs });
  } catch (error) {
    if (error.code === "WORKFLOW_MISSING") return null;
    throw error;
  }
}

async function runWorkflowHook({ workflow, hook, cwd, exec }) {
  const hooks = workflow?.frontMatter?.hooks ?? workflow?.front_matter?.hooks ?? {};
  const spec = hooks?.[hook];
  if (!spec) return null;

  const commands = normalizeHookCommands(spec);
  const results = [];
  for (const argv of commands) {
    const result = await runCommand(argv, { cwd, exec });
    results.push({ argv, ...result });
  }
  return { hook, commands: results };
}

function normalizeHookCommands(spec) {
  if (typeof spec === "string") return [singleStringCommand(spec)];
  if (Array.isArray(spec)) {
    if (spec.every((entry) => typeof entry === "string")) return [spec];
    return spec.flatMap(normalizeHookCommands);
  }
  if (spec && typeof spec === "object") {
    if (Array.isArray(spec.commands)) return spec.commands.flatMap(normalizeHookCommands);
    if (typeof spec.command === "string") {
      const args = spec.args === undefined ? [] : spec.args;
      if (!Array.isArray(args) || !args.every((entry) => typeof entry === "string")) {
        throw new FizzySymphonyError("WORKSPACE_HOOK_INVALID", "Workspace hook args must be a list of strings.", { spec });
      }
      return [[spec.command, ...args]];
    }
  }
  throw new FizzySymphonyError("WORKSPACE_HOOK_INVALID", "Workspace hook must be a command string, argv list, or command object.", { spec });
}

function singleStringCommand(value) {
  const command = String(value).trim();
  if (!command || /\s/u.test(command)) {
    throw new FizzySymphonyError("WORKSPACE_HOOK_INVALID", "String workspace hooks must name one executable without shell syntax.", {
      hook: value
    });
  }
  return [command];
}

async function inspectWorktreeForCleanup({ workspacePath, metadata, exec }) {
  const status = await gitStatus({ cwd: workspacePath, exec });
  const branch = (await runGit(["branch", "--show-current"], { cwd: workspacePath, exec })).stdout.trim();
  const sourceRef = metadata.source_ref ?? metadata.base_ref ?? "HEAD";
  const commitsAhead = await revListCount({ cwd: workspacePath, range: `${sourceRef}..HEAD`, exec });
  const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd: workspacePath,
    exec,
    allowFailure: true
  });
  const unpushedCommits = [];
  if (commitsAhead > 0) {
    if (!upstream.ok) {
      unpushedCommits.push(`${commitsAhead} commit(s) without upstream`);
    } else {
      const aheadUpstream = await revListCount({ cwd: workspacePath, range: `${upstream.stdout.trim()}..HEAD`, exec });
      if (aheadUpstream > 0) unpushedCommits.push(`${aheadUpstream} commit(s) ahead of ${upstream.stdout.trim()}`);
    }
  }
  const merged = commitsAhead === 0
    ? true
    : (await runGit(["merge-base", "--is-ancestor", "HEAD", sourceRef], {
        cwd: workspacePath,
        exec,
        allowFailure: true
      })).ok;

  return {
    clean: status.clean,
    dirty_paths: status.paths,
    untracked_files: status.entries.filter((entry) => entry.status === "??").map((entry) => entry.path),
    unpushed_commits: unpushedCommits,
    branch,
    branch_merged: merged
  };
}

async function revListCount({ cwd, range, exec }) {
  const result = await runGit(["rev-list", "--count", range], { cwd, exec, allowFailure: true });
  if (!result.ok) return 0;
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

async function validateGuardForMetadata({ metadata, metadataPath, guardPath, fs }) {
  const guard = await readJsonIfExists(guardPath, fs);
  if (!guard) {
    return {
      ok: false,
      code: "WORKSPACE_GUARD_MISSING",
      details: { metadata_path: metadataPath, guard_path: guardPath }
    };
  }
  const mismatches = guardMismatches(guard, metadata, metadataPath);
  if (guard.guard !== GUARD_MARKER) mismatches.push("guard");
  if (mismatches.length > 0) {
    return {
      ok: false,
      code: "WORKSPACE_METADATA_GUARD_MISMATCH",
      details: { metadata_path: metadataPath, guard_path: guardPath, mismatches }
    };
  }
  return { ok: true, guard };
}

function workspaceConfig(config, workspaceName) {
  return config?.workspaces?.registry?.[workspaceName] ?? {};
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

function preserve(reason, details = {}) {
  return { action: "preserve", reason, ...details };
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function normalizeError(error = {}) {
  if (typeof error === "string") return { code: "ERROR", message: error };
  return {
    code: error.code ?? "ERROR",
    message: error.message ?? String(error),
    details: error.details ?? {}
  };
}

function buildWorkspaceMetadata({ config, identity, metadata, key, path }) {
  return omitUndefined({
    marker: METADATA_MARKER,
    guard_file_version: GUARD_FILE_VERSION,
    created_at: metadata.created_at ?? new Date().toISOString(),
    ...metadata,
    board_id: identity.board_id,
    card_id: identity.card_id,
    card_number: identity.card_number,
    route_id: identity.route_id,
    route_fingerprint: identity.route_fingerprint,
    instance_id: metadata.instance_id ?? config?.instance?.id,
    workspace_name: identity.workspace_name,
    workspace_key: key,
    workspace_path: path,
    source_repository_path: identity.source_repository_path,
    canonical_source_repository_path: identity.canonical_source_repository_path,
    source_identity: identity.source_identity,
    source_kind: identity.source_kind,
    source_name: identity.source_name,
    source_remote_url: identity.source_remote_url,
    source_display_url: identity.source_display_url,
    source_cache_path: identity.source_cache_path,
    source_fetched_commit_sha: identity.source_fetched_commit_sha,
    source_fetched_at: identity.source_fetched_at,
    base_ref: identity.base_ref,
    source_snapshot_id: identity.source_snapshot_id,
    source_ref: identity.source_ref,
    source_ref_kind: identity.source_ref_kind,
    isolation_strategy: identity.isolation_strategy,
    workspace_identity_digest: identity.workspace_identity_digest
  });
}

function buildGuard({ identity, key, metadataPath }) {
  return omitUndefined({
    guard: GUARD_MARKER,
    guard_file_version: GUARD_FILE_VERSION,
    workspace_key: key,
    workspace_identity_digest: identity.workspace_identity_digest,
    route_id: identity.route_id,
    route_fingerprint: identity.route_fingerprint,
    metadata_path: metadataPath
  });
}

async function readJsonIfExists(path, fs) {
  let raw;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new FizzySymphonyError("WORKSPACE_METADATA_INVALID", "Existing workspace metadata is not valid JSON.", {
      path,
      cause: error.message,
      preserve_workspace: true
    });
  }
}

async function readJsonForScan(path, fs) {
  let raw;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { ok: false, missing: true, error };
    return { ok: false, error };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error };
  }
}

function guardMismatches(guard, metadata, metadataPath) {
  const expected = {
    workspace_key: metadata.workspace_key,
    workspace_identity_digest: metadata.workspace_identity_digest,
    route_id: metadata.route_id,
    route_fingerprint: metadata.route_fingerprint,
    metadata_path: metadataPath
  };
  const mismatches = [];

  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && guard?.[field] !== value) mismatches.push(field);
  }

  return mismatches;
}

async function verifyDurableProofFile({ proof = {}, workspacePath, fs = nodeFs } = {}) {
  const proofFile = proof.file ?? proof.proof_file;
  const expectedDigest = proof.digest ?? proof.proof_digest;
  if (!proofFile || !expectedDigest) {
    return { ok: false, reason: "proof_missing" };
  }

  if (workspacePath) {
    const [canonicalProofFile, canonicalWorkspacePath] = await Promise.all([
      canonicalExistingPath(proofFile, fs),
      canonicalExistingPath(workspacePath, fs)
    ]);
    if (isInsideOrSame(canonicalProofFile, canonicalWorkspacePath)) {
      return {
        ok: false,
        reason: "durable_proof_inside_workspace",
        details: {
          proof_file: proofFile,
          canonical_proof_file: canonicalProofFile,
          workspace_path: workspacePath,
          canonical_workspace_path: canonicalWorkspacePath
        }
      };
    }
  }

  let raw;
  try {
    raw = await fs.readFile(proofFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { ok: false, reason: "proof_file_missing", details: { proof_file: proofFile } };
    }
    return { ok: false, reason: "proof_file_unreadable", details: { proof_file: proofFile, error: normalizeError(error) } };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: "proof_file_invalid", details: { proof_file: proofFile, error: normalizeError(error) } };
  }

  const { proof_digest: fileDigest, ...digestInput } = parsed;
  const actualDigest = digest(digestInput);
  if (fileDigest !== actualDigest || expectedDigest !== actualDigest) {
    return {
      ok: false,
      reason: "proof_digest_mismatch",
      details: {
        proof_file: proofFile,
        expected_digest: expectedDigest,
        file_digest: fileDigest,
        actual_digest: actualDigest
      }
    };
  }

  return { ok: true };
}

async function canonicalExistingPath(path, fs = nodeFs) {
  const resolved = resolve(path);
  try {
    if (typeof fs?.realpath === "function") return await fs.realpath(resolved);
    return realpathSync.native?.(resolved) ?? realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function workspacePreservation({ code, message, metadata_path, guard_path, workspace_key, workspace_path, details = {} }) {
  return omitUndefined({
    code,
    message,
    metadata_path,
    guard_path,
    workspace_key,
    workspace_path,
    preserve_workspace: true,
    details
  });
}

function resolveSourceRef({ config, route, workspace }) {
  const baseRef = workspace.base_ref ?? "HEAD";
  const sourceSnapshotId = route?.source_snapshot_id ?? workspace.source_snapshot_id;

  if (config?.safety?.dirty_source_repo_policy === "snapshot") {
    if (!sourceSnapshotId) {
      throw new FizzySymphonyError(
        "WORKSPACE_SNAPSHOT_ID_REQUIRED",
        "Snapshot source policy requires a source snapshot ID for deterministic workspace identity."
      );
    }
    return {
      base_ref: baseRef,
      source_snapshot_id: sourceSnapshotId,
      source_ref: sourceSnapshotId,
      source_ref_kind: "source_snapshot_id"
    };
  }

  return {
    base_ref: baseRef,
    source_snapshot_id: sourceSnapshotId,
    source_ref: baseRef,
    source_ref_kind: "base_ref"
  };
}

async function resolveWorkspaceSource({ config, route, workspaceName, sourceCache } = {}) {
  const name = workspaceName ?? route?.workspace;
  const workspace = workspaceConfig(config, name);
  if (workspace?.source) {
    const sourceConfig = config?.workspaces?.sources?.[workspace.source];
    if (!sourceConfig) {
      throw new FizzySymphonyError("CONFIG_INVALID_WORKSPACE_SOURCE", "Workspace source must reference a declared workspaces.sources entry.", {
        workspace: name,
        source: workspace.source
      });
    }
    const sourceRef = resolveSourceRef({
      config,
      route,
      workspace: { ...workspace, base_ref: sourceConfig.base_ref ?? workspace.base_ref }
    });
    if (sourceConfig.type === "git_remote") {
      return sourceCache.resolve({
        sourceCacheRoot: config?.workspaces?.source_cache_root,
        sourceName: workspace.source,
        remoteUrl: sourceConfig.remote_url,
        ref: sourceRef.source_ref,
        fetchDepth: sourceConfig.fetch_depth,
        auth: sourceConfig.auth
      });
    }
  }
  return resolveLocalWorkspaceSource({ config, route, workspace, workspaceName: name });
}

function resolveLocalWorkspaceSource({ config, route, workspace, workspaceName } = {}) {
  const sourceRepositoryPath = workspace?.repo ?? config?.workspaces?.default_repo;
  const source = resolveSourceRef({ config, route, workspace });
  return {
    source_kind: "local_path",
    source_name: workspaceName,
    source_repository_path: sourceRepositoryPath,
    canonical_source_repository_path: canonicalPath(sourceRepositoryPath),
    source_identity: canonicalPath(sourceRepositoryPath),
    base_ref: source.base_ref,
    source_snapshot_id: source.source_snapshot_id,
    source_ref: source.source_ref,
    source_ref_kind: source.source_ref_kind
  };
}

function workspacePathFromRoot(root, key, allowedRoots) {
  requireIdentityField("workspace_root", root);
  const resolvedRoot = canonicalPath(root);
  const resolvedPath = resolve(resolvedRoot, String(key));

  assertPathInsideRoot(resolvedPath, resolvedRoot, "WORKSPACE_PATH_ESCAPE", { key });
  assertPathInsideAllowedRoots(resolvedPath, allowedRoots);

  return resolvedPath;
}

function assertPathInsideRoot(path, root, code, details = {}) {
  const resolvedRoot = canonicalPath(root);
  const resolvedPath = resolve(path);
  if (!isInsideOrSame(resolvedPath, resolvedRoot)) {
    throw new FizzySymphonyError(code, "Workspace path escapes its configured root.", {
      ...details,
      root: resolvedRoot,
      path: resolvedPath
    });
  }
}

function assertPathInsideAllowedRoots(path, allowedRoots) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) return;

  const resolvedPath = canonicalPath(path);
  const resolvedRoots = allowedRoots.map((root) => canonicalPath(root));
  if (!resolvedRoots.some((root) => isInsideOrSame(resolvedPath, root))) {
    throw new FizzySymphonyError(
      "WORKSPACE_PATH_OUTSIDE_ALLOWED_ROOT",
      "Workspace path is outside configured safety.allowed_roots.",
      {
        path: resolvedPath,
        allowed_roots: resolvedRoots
      }
    );
  }
}

function isInsideOrSame(path, root) {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

function buildWorkspaceKey(identity) {
  return sanitize([
    identity.board_id,
    identity.workspace_name,
    "card",
    identity.card_number,
    identity.card_id,
    identity.repo_key
  ].join("-"));
}

function identityDigestInput(identity) {
  return omitUndefined({
    board_id: identity.board_id,
    card_id: identity.card_id,
    card_number: identity.card_number,
    workspace_name: identity.workspace_name,
    source_identity: identity.source_identity ?? identity.canonical_source_repository_path,
    base_ref: identity.base_ref,
    source_snapshot_id: identity.source_snapshot_id,
    source_ref: identity.source_ref,
    source_ref_kind: identity.source_ref_kind,
    isolation_strategy: identity.isolation_strategy,
    repo_key: identity.repo_key,
    workspace_key: identity.workspace_key ?? workspaceKey(identity)
  });
}

function canonicalPath(path) {
  const resolved = resolve(path);
  try {
    return realpathSync.native?.(resolved) ?? realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function sanitize(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/gu, "_");
}

function sanitizeBranchPrefix(value) {
  const prefix = String(value)
    .split("/")
    .map((part) => sanitize(part))
    .filter(Boolean)
    .join("/");
  return prefix || "fizzy";
}

function shortDigest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function omitUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function requireIdentityField(field, value) {
  if (value === undefined || value === null || value === "") {
    throw new FizzySymphonyError("WORKSPACE_IDENTITY_MISSING_FIELD", "Workspace identity is missing a required field.", {
      field
    });
  }
}
