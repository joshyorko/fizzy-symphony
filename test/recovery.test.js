import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { createRunRegistry } from "../src/run-registry.js";
import { evaluateCleanupRecovery, performStartupRecovery } from "../src/recovery.js";
import { prepareWorkspace, resolveWorkspaceIdentity } from "../src/workspace.js";

const NOW = "2026-04-29T12:10:00.000Z";
const execFileAsync = promisify(execFile);

function configFixture(dir) {
  return {
    instance: { id: "instance-a" },
    boards: { entries: [{ id: "board_1", enabled: true }] },
    observability: {
      state_dir: join(dir, ".fizzy-symphony", "run")
    },
    workspaces: {
      root: join(dir, ".fizzy-symphony", "workspaces"),
      metadata_root: join(dir, ".fizzy-symphony", "run", "workspaces"),
      default_isolation: "git_worktree",
      registry: {
        app: {
          repo: join(dir, "source"),
          isolation: "git_worktree",
          base_ref: "main",
          worktree_root: join(dir, ".fizzy-symphony", "worktrees")
        }
      }
    },
    safety: {
      allowed_roots: [dir],
      dirty_source_repo_policy: "fail",
      cleanup_policy: "remove_clean_only"
    },
    server: {
      registry_dir: join(dir, ".fizzy-symphony", "run", "instances")
    }
  };
}

function route(overrides = {}) {
  return {
    id: "route_1",
    fingerprint: "sha256:route",
    board_id: "board_1",
    workspace: "app",
    ...overrides
  };
}

function card(overrides = {}) {
  return {
    id: "card_1",
    number: 1,
    board_id: "board_1",
    digest: "sha256:card",
    ...overrides
  };
}

function attemptFor(identity, overrides = {}) {
  return {
    run_id: overrides.run_id ?? `run_${overrides.attempt_id ?? "attempt_1"}`,
    attempt_id: overrides.attempt_id ?? "attempt_1",
    card_id: identity.card_id,
    card_number: identity.card_number,
    board_id: identity.board_id,
    route_id: identity.route_id,
    route_fingerprint: identity.route_fingerprint,
    card_digest: "sha256:card",
    workspace_identity_digest: identity.workspace_identity_digest,
    workspace_path: identity.workspace_path,
    workspace_key: identity.workspace_key,
    claim_id: overrides.claim_id ?? `claim_${overrides.attempt_id ?? "attempt_1"}`,
    runner_kind: "cli_app_server",
    status: "running",
    cleanup_state: "cleanup_planned",
    created_at: "2026-04-29T12:00:00.000Z",
    updated_at: "2026-04-29T12:00:00.000Z",
    ...overrides
  };
}

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

async function initSourceRepo(dir) {
  const source = join(dir, "source");
  await mkdir(source, { recursive: true });
  try {
    await git(source, ["rev-parse", "--is-inside-work-tree"]);
    return;
  } catch {
    // Create the source repository once per temp root.
  }
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.email", "agent@example.test"]);
  await git(source, ["config", "user.name", "Agent"]);
  await writeFile(join(source, "WORKFLOW.md"), "# Policy\n", "utf8");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "initial"]);
}

async function preparedIdentity(dir, overrides = {}) {
  await initSourceRepo(dir);
  const config = configFixture(dir);
  const identity = resolveWorkspaceIdentity({
    config,
    route: route(overrides.route),
    card: card(overrides.card)
  });
  const prepared = await prepareWorkspace({
    config,
    identity,
    metadata: {
      run_attempt_id: overrides.attempt_id ?? "attempt_1",
      created_at: "2026-04-29T12:00:00.000Z"
    }
  });
  return { config, identity, prepared };
}

test("startup recovery marks claiming, preparing, preparing_workspace, and running attempts interrupted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-recovery-interrupt-"));
  const { config, identity } = await preparedIdentity(dir);
  const registry = createRunRegistry({ stateDir: config.observability.state_dir });
  const statuses = ["claiming", "preparing", "preparing_workspace", "running"];

  for (const [index, status] of statuses.entries()) {
    await registry.writeAttempt(attemptFor(identity, {
      run_id: `run_${index}`,
      attempt_id: `attempt_${index}`,
      status,
      created_at: `2026-04-29T12:0${index}:00.000Z`
    }));
  }
  await registry.writeAttempt(attemptFor(identity, {
    run_id: "run_completed",
    attempt_id: "attempt_completed",
    status: "completed",
    created_at: "2026-04-29T12:09:00.000Z"
  }));

  const report = await performStartupRecovery({
    config,
    runRegistry: registry,
    claimComments: [],
    now: NOW,
    inspectInstances: async () => ({ removed_stale_instances: [], live_instances: [], warnings: [], errors: [] })
  });
  const recovered = await registry.readAttempts();

  assert.deepEqual(report.interrupted_attempts.map((entry) => entry.attempt_id), [
    "attempt_0",
    "attempt_1",
    "attempt_2",
    "attempt_3"
  ]);
  assert.deepEqual(
    recovered.filter((entry) => entry.attempt_id !== "attempt_completed").map((entry) => entry.status),
    ["interrupted", "interrupted", "interrupted", "interrupted"]
  );
  assert.equal(recovered.find((entry) => entry.attempt_id === "attempt_3").workspace_preserved, true);
  assert.equal(recovered.find((entry) => entry.attempt_id === "attempt_completed").status, "completed");
});

test("startup recovery preserves workspaces with missing guards and guard metadata mismatches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-recovery-workspaces-"));
  const first = await preparedIdentity(dir, { card: { id: "card_missing_guard", number: 10 }, attempt_id: "attempt_guard" });
  const second = await preparedIdentity(dir, { card: { id: "card_mismatch", number: 11 }, attempt_id: "attempt_mismatch" });

  await rm(first.prepared.guard_path);
  await writeFile(second.prepared.guard_path, `${JSON.stringify({
    ...second.prepared.guard,
    route_fingerprint: "sha256:different"
  }, null, 2)}\n`, "utf8");

  const registry = createRunRegistry({ stateDir: first.config.observability.state_dir });
  const report = await performStartupRecovery({
    config: first.config,
    runRegistry: registry,
    claimComments: [],
    now: NOW,
    inspectInstances: async () => ({ removed_stale_instances: [], live_instances: [], warnings: [], errors: [] })
  });

  assert.deepEqual(
    report.preserved_workspaces.map((entry) => entry.code).sort(),
    ["WORKSPACE_GUARD_MISSING", "WORKSPACE_METADATA_GUARD_MISMATCH"]
  );
  assert.deepEqual(
    report.warnings.map((entry) => entry.code).filter((code) => code.startsWith("WORKSPACE_")).sort(),
    ["WORKSPACE_GUARD_MISSING", "WORKSPACE_METADATA_GUARD_MISMATCH"]
  );
});

test("startup recovery marks cleanup_started and archive_started attempts recoverable only after proof and handoff checks pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-recovery-cleanup-"));
  const { config, identity } = await preparedIdentity(dir);
  const registry = createRunRegistry({ stateDir: config.observability.state_dir });
  const proofDir = join(config.observability.state_dir, "proof");
  await mkdir(proofDir, { recursive: true });
  const proofFile = join(proofDir, "attempt_cleanup.json");
  await writeFile(proofFile, `${JSON.stringify({ attempt_id: "attempt_cleanup", no_code_change: true }, null, 2)}\n`, "utf8");

  await registry.writeAttempt(attemptFor(identity, {
    attempt_id: "attempt_cleanup",
    run_id: "run_cleanup",
    status: "completed",
    cleanup_state: "cleanup_started",
    proof_file: proofFile,
    proof_digest: "sha256:proof",
    result_comment_id: "comment_1",
    completion_policy_state: "completed",
    terminal_claim_status: "completed",
    terminal_claim_persisted: true,
    no_code_change: true,
    filesystem_evidence: { clean: true, untracked_files: [], unpushed_commits: [], branch_merged: true }
  }));

  await registry.writeAttempt(attemptFor(identity, {
    attempt_id: "attempt_archive",
    run_id: "run_archive",
    status: "completed",
    cleanup_state: "archive_started",
    proof_file: proofFile,
    proof_digest: "sha256:proof",
    result_comment_id: null,
    completion_policy_state: "completed",
    terminal_claim_status: "completed",
    terminal_claim_persisted: true,
    no_code_change: true,
    filesystem_evidence: { clean: true, untracked_files: [], unpushed_commits: [], branch_merged: true }
  }));

  const report = await performStartupRecovery({
    config,
    runRegistry: registry,
    claimComments: [],
    now: NOW,
    inspectInstances: async () => ({ removed_stale_instances: [], live_instances: [], warnings: [], errors: [] })
  });
  const recovered = await registry.readAttempts();

  assert.deepEqual(report.cleanup_recovery.recoverable.map((entry) => entry.attempt_id), ["attempt_cleanup"]);
  assert.deepEqual(report.cleanup_recovery.preserved.map((entry) => entry.attempt_id), ["attempt_archive"]);
  assert.equal(recovered.find((entry) => entry.attempt_id === "attempt_cleanup").cleanup_recovery_state, "safe_to_resume");
  assert.equal(recovered.find((entry) => entry.attempt_id === "attempt_archive").cleanup_state, "cleanup_preserved");
  assert.equal(recovered.find((entry) => entry.attempt_id === "attempt_archive").manual_intervention_required, true);
});

test("cleanup recovery blocks missing durable proof, handoff, terminal claim, workspace, and filesystem evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cleanup-gates-"));
  const { config, identity } = await preparedIdentity(dir);
  const proofDir = join(config.observability.state_dir, "proof");
  await mkdir(proofDir, { recursive: true });
  const proofFile = join(proofDir, "attempt_cleanup.json");
  await writeFile(proofFile, `${JSON.stringify({ attempt_id: "attempt_cleanup", no_code_change: true }, null, 2)}\n`, "utf8");

  const safeAttempt = attemptFor(identity, {
    attempt_id: "attempt_cleanup",
    status: "completed",
    cleanup_state: "cleanup_started",
    proof_file: proofFile,
    proof_digest: "sha256:proof",
    result_comment_id: "comment_1",
    completion_policy_state: "completed",
    terminal_claim_status: "completed",
    terminal_claim_persisted: true,
    no_code_change: true,
    filesystem_evidence: { clean: true, untracked_files: [], unpushed_commits: [], branch_merged: true }
  });

  const cases = [
    ["missing proof", (entry) => ({ ...entry, proof_file: join(proofDir, "missing.json") }), "CLEANUP_PROOF_MISSING"],
    ["missing result handoff", (entry) => ({ ...entry, result_comment_id: null }), "CLEANUP_HANDOFF_MISSING"],
    ["failed completion policy", (entry) => ({ ...entry, completion_policy_state: "failed" }), "CLEANUP_COMPLETION_POLICY_UNSAFE"],
    ["missing terminal claim", (entry) => ({ ...entry, terminal_claim_persisted: false }), "CLEANUP_TERMINAL_CLAIM_MISSING"],
    ["missing workspace guard", async (entry, setup) => {
      await rm(setup.prepared.guard_path);
      return entry;
    }, "WORKSPACE_GUARD_MISSING"],
    ["dirty filesystem evidence", (entry) => ({
      ...entry,
      filesystem_evidence: { clean: false, untracked_files: ["debug.log"], unpushed_commits: [], branch_merged: true }
    }), "CLEANUP_FILESYSTEM_UNSAFE"]
  ];

  for (const [name, mutate, expectedCode] of cases) {
    const nextDir = await mkdtemp(join(tmpdir(), `fizzy-symphony-cleanup-${name.replaceAll(" ", "-")}-`));
    const setup = await preparedIdentity(nextDir);
    const nextProofDir = join(setup.config.observability.state_dir, "proof");
    await mkdir(nextProofDir, { recursive: true });
    const nextProofFile = join(nextProofDir, "attempt_cleanup.json");
    await writeFile(nextProofFile, `${JSON.stringify({ attempt_id: "attempt_cleanup", no_code_change: true }, null, 2)}\n`, "utf8");
    const base = { ...safeAttempt, workspace_path: setup.identity.workspace_path, workspace_key: setup.identity.workspace_key, workspace_identity_digest: setup.identity.workspace_identity_digest, proof_file: nextProofFile };
    const mutated = await mutate(base, setup);
    const result = await evaluateCleanupRecovery({ config: setup.config, attempt: mutated, now: NOW });

    assert.equal(result.safe_to_resume, false, name);
    assert.equal(result.reasons.some((reason) => reason.code === expectedCode), true, name);
  }
});
