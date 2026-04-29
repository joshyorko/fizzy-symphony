import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  branchName,
  prepareWorkspace,
  resolveWorkspaceIdentity,
  scanWorkspaceMetadata,
  validateExistingWorkspaceMetadata,
  workspaceKey,
  workspacePath
} from "../src/workspace.js";

function shortDigest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function baseConfig(dir, overrides = {}) {
  return {
    instance: { id: "instance_1" },
    workspaces: {
      root: join(dir, ".fizzy-symphony", "workspaces"),
      metadata_root: join(dir, ".fizzy-symphony", "run", "workspaces"),
      default_isolation: "git_worktree",
      registry: {
        app: {
          repo: join(dir, "source repo"),
          isolation: "git_worktree",
          base_ref: "main",
          worktree_root: join(dir, ".fizzy-symphony", "worktrees"),
          branch_prefix: "fizzy",
          workflow_path: "WORKFLOW.md",
          require_clean_source: true
        }
      }
    },
    safety: {
      allowed_roots: [dir],
      dirty_source_repo_policy: "fail"
    },
    ...overrides
  };
}

function route(overrides = {}) {
  return {
    id: "board:board_1:column:ready:golden:golden_1",
    fingerprint: "sha256:routefingerprint",
    board_id: "board_1",
    workspace: "app",
    ...overrides
  };
}

function card(overrides = {}) {
  return {
    id: "card_abcdef123456",
    number: 42,
    board_id: "board_1",
    ...overrides
  };
}

test("resolveWorkspaceIdentity builds deterministic identity, key, path, and branch name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-workspace-"));
  const config = baseConfig(dir);
  const identity = resolveWorkspaceIdentity({
    config,
    route: route(),
    card: card({ id: "card/abc 123" })
  });

  const canonicalRepo = resolve(dir, "source repo");
  const repoKey = shortDigest(`${canonicalRepo}@main`);
  const key = workspaceKey(identity);

  assert.equal(identity.board_id, "board_1");
  assert.equal(identity.card_id, "card/abc 123");
  assert.equal(identity.card_number, 42);
  assert.equal(identity.workspace_name, "app");
  assert.equal(identity.source_repository_path, join(dir, "source repo"));
  assert.equal(identity.canonical_source_repository_path, canonicalRepo);
  assert.equal(identity.source_ref, "main");
  assert.equal(identity.source_ref_kind, "base_ref");
  assert.equal(identity.isolation_strategy, "git_worktree");
  assert.equal(key, `board_1-app-card-42-card_abc_123-${repoKey}`);
  assert.equal(identity.workspace_key, key);
  assert.equal(identity.workspace_path, join(dir, ".fizzy-symphony", "worktrees", key));
  assert.equal(workspacePath(config, key), join(dir, ".fizzy-symphony", "workspaces", key));

  const branch = branchName(identity);
  const shortIdentity = identity.workspace_identity_digest.replace(/^sha256:/u, "").slice(0, 12);
  assert.equal(branch, `fizzy/board_1-card-42-card_abc_123-app-${shortIdentity}`);
  assert.equal(branchName(identity), branch);
});

test("resolveWorkspaceIdentity rejects unknown workspace names without falling back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-unknown-workspace-"));
  const config = baseConfig(dir);

  assert.throws(
    () => resolveWorkspaceIdentity({
      config,
      route: route({ workspace: "api" }),
      card: card()
    }),
    (error) => error.code === "UNKNOWN_WORKSPACE" &&
      error.details.workspace === "api" &&
      error.details.available_workspaces.includes("app")
  );
});

test("workspacePath rejects key escapes and roots outside configured allowed_roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-path-safety-"));
  const config = baseConfig(dir);

  assert.throws(
    () => workspacePath(config, "../escape"),
    (error) => error.code === "WORKSPACE_PATH_ESCAPE" && error.details.key === "../escape"
  );

  assert.throws(
    () => workspacePath({
      ...config,
      workspaces: {
        ...config.workspaces,
        root: join(tmpdir(), "outside-fizzy-root")
      }
    }, "safe-key"),
    (error) => error.code === "WORKSPACE_PATH_OUTSIDE_ALLOWED_ROOT" &&
      error.details.allowed_roots.includes(resolve(dir))
  );
});

test("prepareWorkspace writes guard and metadata before runner dispatch would start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-prepare-"));
  const config = baseConfig(dir);
  const identity = resolveWorkspaceIdentity({ config, route: route(), card: card() });
  const metadata = {
    run_attempt_id: "attempt_1",
    created_at: "2026-04-29T12:00:00.000Z"
  };

  const prepared = await prepareWorkspace({ config, identity, metadata });

  assert.equal(prepared.workspace_key, identity.workspace_key);
  assert.equal(prepared.workspace_path, identity.workspace_path);
  assert.equal(prepared.metadata_path, join(config.workspaces.metadata_root, `${identity.workspace_key}.json`));
  assert.equal(prepared.guard_path, join(identity.workspace_path, ".fizzy-symphony-workspace-guard.json"));

  const writtenMetadata = JSON.parse(await readFile(prepared.metadata_path, "utf8"));
  assert.equal(writtenMetadata.guard_file_version, 1);
  assert.equal(writtenMetadata.route_fingerprint, route().fingerprint);
  assert.equal(writtenMetadata.workspace_identity_digest, identity.workspace_identity_digest);
  assert.equal(writtenMetadata.workspace_key, identity.workspace_key);
  assert.equal(writtenMetadata.instance_id, "instance_1");
  assert.equal(writtenMetadata.run_attempt_id, "attempt_1");
  assert.equal(writtenMetadata.created_at, "2026-04-29T12:00:00.000Z");

  const guard = JSON.parse(await readFile(prepared.guard_path, "utf8"));
  assert.equal(guard.guard_file_version, 1);
  assert.equal(guard.route_fingerprint, route().fingerprint);
  assert.equal(guard.workspace_identity_digest, identity.workspace_identity_digest);
});

test("metadata mismatch preserves existing workspace metadata and fails dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-metadata-mismatch-"));
  const config = baseConfig(dir);
  const identity = resolveWorkspaceIdentity({ config, route: route(), card: card() });
  const prepared = await prepareWorkspace({
    config,
    identity,
    metadata: { run_attempt_id: "attempt_1", created_at: "2026-04-29T12:00:00.000Z" }
  });
  const existing = JSON.parse(await readFile(prepared.metadata_path, "utf8"));
  const mismatched = {
    ...existing,
    route_fingerprint: "sha256:different-route"
  };
  await writeFile(prepared.metadata_path, `${JSON.stringify(mismatched, null, 2)}\n`, "utf8");

  await assert.rejects(
    () => prepareWorkspace({
      config,
      identity,
      metadata: { run_attempt_id: "attempt_2", created_at: "2026-04-29T12:05:00.000Z" }
    }),
    (error) => error.code === "WORKSPACE_METADATA_MISMATCH" &&
      error.details.preserve_workspace === true &&
      error.details.mismatches.includes("route_fingerprint")
  );

  const preserved = JSON.parse(await readFile(prepared.metadata_path, "utf8"));
  assert.equal(preserved.route_fingerprint, "sha256:different-route");
  assert.equal(preserved.run_attempt_id, "attempt_1");
});

test("validateExistingWorkspaceMetadata rejects identity and canonical repository mismatches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-validate-metadata-"));
  const config = baseConfig(dir);
  const identity = resolveWorkspaceIdentity({ config, route: route(), card: card() });

  assert.throws(
    () => validateExistingWorkspaceMetadata({
      workspace_identity_digest: "sha256:different-identity",
      route_fingerprint: identity.route_fingerprint,
      canonical_source_repository_path: join(dir, "other-repo")
    }, identity),
    (error) => error.code === "WORKSPACE_METADATA_MISMATCH" &&
      error.details.preserve_workspace === true &&
      error.details.mismatches.includes("workspace_identity_digest") &&
      error.details.mismatches.includes("canonical_source_repository_path")
  );
});

test("scanWorkspaceMetadata preserves workspaces with missing guards and guard metadata mismatches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-scan-metadata-"));
  const config = baseConfig(dir);
  const identity = resolveWorkspaceIdentity({ config, route: route(), card: card({ id: "card_missing", number: 1 }) });
  const missingGuard = await prepareWorkspace({
    config,
    identity,
    metadata: { run_attempt_id: "attempt_missing", created_at: "2026-04-29T12:00:00.000Z" }
  });
  const mismatchIdentity = resolveWorkspaceIdentity({
    config,
    route: route(),
    card: card({ id: "card_mismatch", number: 2 })
  });
  const mismatch = await prepareWorkspace({
    config,
    identity: mismatchIdentity,
    metadata: { run_attempt_id: "attempt_mismatch", created_at: "2026-04-29T12:00:00.000Z" }
  });

  await rm(missingGuard.guard_path);
  await writeFile(mismatch.guard_path, `${JSON.stringify({
    ...mismatch.guard,
    workspace_identity_digest: "sha256:different"
  }, null, 2)}\n`, "utf8");

  const report = await scanWorkspaceMetadata({ config });

  assert.equal(report.workspaces.length, 2);
  assert.deepEqual(
    report.preserved_workspaces.map((entry) => entry.code).sort(),
    ["WORKSPACE_GUARD_MISSING", "WORKSPACE_METADATA_GUARD_MISMATCH"]
  );
  assert.equal(report.preserved_workspaces.find((entry) => entry.code === "WORKSPACE_GUARD_MISSING").workspace_key, identity.workspace_key);
  assert.equal(report.preserved_workspaces.find((entry) => entry.code === "WORKSPACE_METADATA_GUARD_MISMATCH").workspace_key, mismatchIdentity.workspace_key);
});
