import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  branchName,
  cleanupWorkspace,
  prepareWorkspace,
  preflightWorkspaceSource,
  resolveWorkspaceIdentity,
  scanWorkspaceMetadata,
  validateExistingWorkspaceMetadata,
  workspaceKey,
  workspacePath
} from "../src/workspace.js";

const execFileAsync = promisify(execFile);

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

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd });
  return String(result.stdout ?? "").trim();
}

async function initSourceRepo(dir, { workflow = "# Policy\n", extraFiles = {} } = {}) {
  const source = join(dir, "source repo");
  await mkdir(source, { recursive: true });
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.email", "agent@example.test"]);
  await git(source, ["config", "user.name", "Agent"]);
  await writeFile(join(source, "WORKFLOW.md"), workflow, "utf8");
  for (const [path, content] of Object.entries(extraFiles)) {
    const fullPath = join(source, path);
    await mkdir(resolve(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "initial"]);
  return source;
}

async function assertMissing(path) {
  await assert.rejects(() => access(path), (error) => error.code === "ENOENT");
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
  await initSourceRepo(dir);
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

test("prepareWorkspace creates a deterministic git worktree branch and runs create/run hooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-worktree-create-"));
  const hookScript = [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync('../hook.log', `${process.argv[2]}\\n`);"
  ].join("\n");
  await initSourceRepo(dir, {
    workflow: [
      "---",
      "hooks:",
      "  after_create:",
      "    command: node",
      "    args:",
      "      - hooks.js",
      "      - after_create",
      "  before_run:",
      "    command: node",
      "    args:",
      "      - hooks.js",
      "      - before_run",
      "---",
      "# Policy",
      ""
    ].join("\n"),
    extraFiles: { "hooks.js": hookScript }
  });
  const config = baseConfig(dir);
  const identity = resolveWorkspaceIdentity({ config, route: route(), card: card() });

  const prepared = await prepareWorkspace({
    config,
    identity,
    metadata: { run_attempt_id: "attempt_1", created_at: "2026-04-29T12:00:00.000Z" }
  });

  assert.equal(await git(prepared.workspace_path, ["branch", "--show-current"]), branchName(identity));
  assert.equal(await git(prepared.workspace_path, ["rev-parse", "--show-toplevel"]), prepared.workspace_path);
  assert.deepEqual((await readFile(join(config.workspaces.registry.app.worktree_root, "hook.log"), "utf8")).trim().split("\n"), [
    "after_create",
    "before_run"
  ]);

  const writtenMetadata = JSON.parse(await readFile(prepared.metadata_path, "utf8"));
  assert.equal(writtenMetadata.branch_name, branchName(identity));
  assert.equal(writtenMetadata.workspace_path, prepared.workspace_path);
});

test("prepareWorkspace reuses a clean matching worktree without rerunning after_create", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-worktree-reuse-"));
  await initSourceRepo(dir);
  const config = baseConfig(dir);
  const identity = resolveWorkspaceIdentity({ config, route: route(), card: card() });

  const first = await prepareWorkspace({
    config,
    identity,
    metadata: { run_attempt_id: "attempt_1", created_at: "2026-04-29T12:00:00.000Z" }
  });
  const second = await prepareWorkspace({
    config,
    identity,
    metadata: { run_attempt_id: "attempt_2", created_at: "2026-04-29T12:05:00.000Z" }
  });

  assert.equal(second.workspace_path, first.workspace_path);
  assert.equal(await git(second.workspace_path, ["branch", "--show-current"]), branchName(identity));
  assert.equal(second.created, false);

  const writtenMetadata = JSON.parse(await readFile(second.metadata_path, "utf8"));
  assert.equal(writtenMetadata.run_attempt_id, "attempt_2");
});

test("prepareWorkspace preserves a dirty existing worktree instead of reusing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-worktree-dirty-"));
  await initSourceRepo(dir);
  const config = baseConfig(dir);
  const identity = resolveWorkspaceIdentity({ config, route: route(), card: card() });
  const prepared = await prepareWorkspace({
    config,
    identity,
    metadata: { run_attempt_id: "attempt_1", created_at: "2026-04-29T12:00:00.000Z" }
  });
  await writeFile(join(prepared.workspace_path, "debug.log"), "keep me\n", "utf8");

  await assert.rejects(
    () => prepareWorkspace({
      config,
      identity,
      metadata: { run_attempt_id: "attempt_2", created_at: "2026-04-29T12:05:00.000Z" }
    }),
    (error) => error.code === "WORKSPACE_WORKTREE_DIRTY" &&
      error.details.preserve_workspace === true &&
      error.details.workspace_path === prepared.workspace_path
  );

  assert.equal(await readFile(join(prepared.workspace_path, "debug.log"), "utf8"), "keep me\n");
});

test("preflightWorkspaceSource rejects dirty source repositories when policy requires a clean source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-source-dirty-"));
  const source = await initSourceRepo(dir);
  const config = baseConfig(dir);
  const identity = resolveWorkspaceIdentity({ config, route: route(), card: card() });
  await writeFile(join(source, "scratch.txt"), "dirty\n", "utf8");

  await assert.rejects(
    () => preflightWorkspaceSource({ config, identity }),
    (error) => error.code === "WORKSPACE_SOURCE_DIRTY" &&
      error.details.preserve_workspace === true &&
      error.details.source_repository_path === resolve(source)
  );
});

test("preflightWorkspaceSource treats nonzero injected git results as failed commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-injected-git-failure-"));
  const config = baseConfig(dir);
  const identity = resolveWorkspaceIdentity({ config, route: route(), card: card() });
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
      return { stdout: "true\n", stderr: "", exit_code: 0 };
    }
    if (args[0] === "cat-file") {
      return { stdout: "", stderr: "missing ref\n", exit_code: 1 };
    }
    if (args[0] === "status") {
      return { stdout: "", stderr: "", exit_code: 0 };
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  };

  await assert.rejects(
    () => preflightWorkspaceSource({ config, identity, exec }),
    (error) => error.code === "WORKSPACE_SOURCE_REF_INVALID" &&
      error.details.source_ref === "main"
  );
  assert.deepEqual(calls.map((call) => call.args.slice(0, 2)), [
    ["rev-parse", "--is-inside-work-tree"],
    ["cat-file", "-e"]
  ]);
});

test("preflightWorkspaceSource allows dirty source repositories when snapshot policy supplies a commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-source-snapshot-"));
  const source = await initSourceRepo(dir);
  const snapshot = await git(source, ["rev-parse", "HEAD"]);
  const config = baseConfig(dir, {
    safety: {
      allowed_roots: [dir],
      dirty_source_repo_policy: "snapshot"
    }
  });
  const identity = resolveWorkspaceIdentity({
    config,
    route: route({ source_snapshot_id: snapshot }),
    card: card()
  });
  await writeFile(join(source, "scratch.txt"), "dirty\n", "utf8");

  const preflight = await preflightWorkspaceSource({ config, identity });

  assert.equal(preflight.status, "ok");
  assert.equal(preflight.clean, false);
  assert.equal(identity.source_ref, snapshot);

  const prepared = await prepareWorkspace({
    config,
    identity,
    metadata: { run_attempt_id: "attempt_1", created_at: "2026-04-29T12:00:00.000Z" }
  });
  const writtenMetadata = JSON.parse(await readFile(prepared.metadata_path, "utf8"));

  assert.equal(writtenMetadata.source_snapshot_id, snapshot);
  assert.equal(writtenMetadata.source_ref_kind, "source_snapshot_id");
});

test("prepareWorkspace treats nonzero injected hook results as hook failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-injected-hook-failure-"));
  await initSourceRepo(dir, {
    workflow: [
      "---",
      "hooks:",
      "  before_run:",
      "    command: failing-hook",
      "---",
      "# Policy",
      ""
    ].join("\n")
  });
  const config = baseConfig(dir);
  const identity = resolveWorkspaceIdentity({ config, route: route(), card: card() });
  const exec = async (file, args, options) => {
    if (file === "failing-hook") {
      return { stdout: "", stderr: "hook failed\n", exit_code: 7 };
    }
    return execFileAsync(file, args, options);
  };

  await assert.rejects(
    () => prepareWorkspace({
      config,
      identity,
      metadata: { run_attempt_id: "attempt_1", created_at: "2026-04-29T12:00:00.000Z" },
      exec
    }),
    (error) => error.code === "WORKSPACE_HOOK_FAILED" &&
      error.details.exit_code === 7 &&
      error.details.stderr === "hook failed\n"
  );
});

test("cleanupWorkspace removes clean proven worktrees with non-force git worktree removal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cleanup-remove-"));
  const hookScript = [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync('../remove.log', 'before_remove\\n');"
  ].join("\n");
  await initSourceRepo(dir, {
    workflow: [
      "---",
      "hooks:",
      "  before_remove:",
      "    command: node",
      "    args:",
      "      - hooks.js",
      "---",
      "# Policy",
      ""
    ].join("\n"),
    extraFiles: { "hooks.js": hookScript }
  });
  const config = baseConfig(dir, {
    safety: {
      allowed_roots: [dir],
      dirty_source_repo_policy: "fail",
      cleanup: { policy: "remove_clean_only" }
    }
  });
  const identity = resolveWorkspaceIdentity({ config, route: route(), card: card() });
  const prepared = await prepareWorkspace({
    config,
    identity,
    metadata: { run_attempt_id: "attempt_1", created_at: "2026-04-29T12:00:00.000Z" }
  });
  const proof = {
    file: join(dir, ".fizzy-symphony", "run", "proof", "run_1.json"),
    digest: "sha256:proof",
    payload: { no_code_change: true }
  };
  await mkdir(resolve(proof.file, ".."), { recursive: true });
  await writeFile(proof.file, "{}\n", "utf8");

  const result = await cleanupWorkspace({
    config,
    workspace: prepared,
    proof,
    resultComment: { id: "comment_1" },
    completionMarker: { id: "marker_1" },
    claimRelease: { released: true }
  });

  assert.equal(result.action, "removed");
  assert.equal(result.method, "git_worktree_remove");
  assert.equal(result.force, false);
  assert.equal(await readFile(join(config.workspaces.registry.app.worktree_root, "remove.log"), "utf8"), "before_remove\n");
  await assertMissing(prepared.workspace_path);
  await assertMissing(prepared.metadata_path);
});

test("cleanupWorkspace preserves dirty and unpushed worktrees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cleanup-preserve-"));
  await initSourceRepo(dir);
  const config = baseConfig(dir, {
    safety: {
      allowed_roots: [dir],
      dirty_source_repo_policy: "fail",
      cleanup: { policy: "remove_clean_only" }
    }
  });
  const identity = resolveWorkspaceIdentity({ config, route: route(), card: card() });
  const prepared = await prepareWorkspace({
    config,
    identity,
    metadata: { run_attempt_id: "attempt_1", created_at: "2026-04-29T12:00:00.000Z" }
  });
  const proof = {
    file: join(dir, ".fizzy-symphony", "run", "proof", "run_1.json"),
    digest: "sha256:proof",
    payload: { no_code_change: true }
  };
  await mkdir(resolve(proof.file, ".."), { recursive: true });
  await writeFile(proof.file, "{}\n", "utf8");
  const complete = {
    config,
    workspace: prepared,
    proof,
    resultComment: { id: "comment_1" },
    completionMarker: { id: "marker_1" },
    claimRelease: { released: true }
  };

  await writeFile(join(prepared.workspace_path, "debug.log"), "dirty\n", "utf8");
  const dirty = await cleanupWorkspace(complete);
  assert.equal(dirty.action, "preserve");
  assert.equal(dirty.reason, "worktree_dirty");
  await rm(join(prepared.workspace_path, "debug.log"));

  await writeFile(join(prepared.workspace_path, "feature.txt"), "new work\n", "utf8");
  await git(prepared.workspace_path, ["add", "feature.txt"]);
  await git(prepared.workspace_path, ["commit", "-m", "feature"]);
  const unpushed = await cleanupWorkspace(complete);
  assert.equal(unpushed.action, "preserve");
  assert.equal(unpushed.reason, "worktree_unpushed");
  assert.equal(await git(prepared.workspace_path, ["branch", "--show-current"]), branchName(identity));
});

test("metadata mismatch preserves existing workspace metadata and fails dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-metadata-mismatch-"));
  await initSourceRepo(dir);
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
  await initSourceRepo(dir);
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
