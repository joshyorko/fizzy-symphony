import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { FizzySymphonyError } from "./errors.js";

const GUARD_FILE_VERSION = 1;
const GUARD_FILE_NAME = ".fizzy-symphony-workspace-guard.json";
const METADATA_MARKER = "fizzy-symphony:workspace-metadata:v1";
const GUARD_MARKER = "fizzy-symphony:workspace-guard:v1";
const SUPPORTED_ISOLATION_STRATEGIES = new Set(["git_worktree", "git_clone", "copy"]);

const nodeFs = { mkdir, readdir, readFile, writeFile };

export function resolveWorkspaceIdentity({ config, route, card, workspaceName } = {}) {
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

  const sourceRepositoryPath = workspace.repo ?? config?.workspaces?.default_repo;
  requireIdentityField("source_repository_path", sourceRepositoryPath);

  const canonicalSourceRepositoryPath = canonicalPath(sourceRepositoryPath);
  const isolationStrategy = workspace.isolation ?? config?.workspaces?.default_isolation ?? "git_worktree";
  if (!SUPPORTED_ISOLATION_STRATEGIES.has(isolationStrategy)) {
    throw new FizzySymphonyError("UNSUPPORTED_WORKSPACE_ISOLATION", "Workspace isolation strategy is not supported.", {
      workspace: name,
      isolation_strategy: isolationStrategy,
      supported: [...SUPPORTED_ISOLATION_STRATEGIES].sort()
    });
  }

  const source = resolveSourceRef({ config, route, workspace });
  const repoKey = shortDigest(`${canonicalSourceRepositoryPath}@${source.source_ref}`);
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
    base_ref: source.base_ref,
    source_snapshot_id: source.source_snapshot_id,
    source_ref: source.source_ref,
    source_ref_kind: source.source_ref_kind,
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
  const repoKey = identity.repo_key ?? shortDigest(`${identity.canonical_source_repository_path}@${identity.source_ref}`);
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

export async function prepareWorkspace({ config, identity, metadata = {}, fs = nodeFs } = {}) {
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

  const fullMetadata = buildWorkspaceMetadata({ config, identity, metadata, key, path });
  const guard = buildGuard({ identity, key, metadataPath });

  await fs.mkdir(path, { recursive: true });
  await fs.mkdir(metadataRoot, { recursive: true });
  await fs.writeFile(guardPath, `${JSON.stringify(guard, null, 2)}\n`, "utf8");
  await fs.writeFile(metadataPath, `${JSON.stringify(fullMetadata, null, 2)}\n`, "utf8");

  return {
    workspace_key: key,
    workspace_path: path,
    guard_path: guardPath,
    metadata_path: metadataPath,
    guard,
    metadata: fullMetadata
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

function workspacePathFromRoot(root, key, allowedRoots) {
  requireIdentityField("workspace_root", root);
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, String(key));

  assertPathInsideRoot(resolvedPath, resolvedRoot, "WORKSPACE_PATH_ESCAPE", { key });
  assertPathInsideAllowedRoots(resolvedPath, allowedRoots);

  return resolvedPath;
}

function assertPathInsideRoot(path, root, code, details = {}) {
  const resolvedRoot = resolve(root);
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

  const resolvedPath = resolve(path);
  const resolvedRoots = allowedRoots.map((root) => resolve(root));
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
    canonical_source_repository_path: identity.canonical_source_repository_path,
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
  return resolve(path);
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
