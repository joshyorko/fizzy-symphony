import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createStatusStore } from "../src/status.js";

function configFixture() {
  return {
    boards: {
      entries: [
        { id: "board_1", label: "Agents", enabled: true },
        { id: "board_disabled", label: "Disabled", enabled: false }
      ]
    },
    polling: { interval_ms: 30000 },
    webhook: { enabled: true, manage: false },
    agent: { max_concurrent: 2 },
    runner: { preferred: "cli_app_server" },
    observability: {
      state_dir: ".fizzy-symphony/run",
      status_snapshot_path: ".fizzy-symphony/run/status/latest.json"
    }
  };
}

function createStore() {
  return createStatusStore({
    instance: {
      id: "instance-a",
      label: "local",
      endpoint: {
        host: "127.0.0.1",
        port: 4567,
        base_url: "http://127.0.0.1:4567"
      }
    },
    startedAt: "2026-04-29T12:00:00.000Z",
    config: configFixture()
  });
}

test("health reports process liveness while ready reports startup and runner blockers", () => {
  const store = createStore();

  store.recordStartupValidation({
    errors: [{ code: "STARTUP_VALIDATION_FAILED", message: "Fizzy access is unsafe." }],
    warnings: [{ code: "ENTROPY_UNKNOWN", message: "Entropy settings were not visible." }]
  });
  store.updateRunnerHealth({
    status: "unavailable",
    kind: "cli_app_server",
    reason: "app-server is not ready"
  });

  const health = store.health();
  assert.equal(health.live, true);
  assert.equal(health.status, "live");
  assert.equal(health.instance_id, "instance-a");
  assert.equal(health.ready, false);

  const readiness = store.ready();
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockers.map((blocker) => blocker.code), ["STARTUP_ERRORS", "RUNNER_NOT_READY"]);
  assert.equal(readiness.runner_health.reason, "app-server is not ready");

  const snapshot = store.status();
  assert.equal(snapshot.health.live, true);
  assert.equal(snapshot.readiness.ready, false);
  assert.equal(snapshot.validation.errors[0].code, "STARTUP_VALIDATION_FAILED");
  assert.equal(snapshot.validation.warnings[0].code, "ENTROPY_UNKNOWN");
});

test("status tracks routes, run buckets, poll state, warnings, errors, instance metadata, and disk snapshots", async () => {
  const store = createStore();
  const route = {
    id: "board:board_1:column:col_ready:golden:golden_1",
    board_id: "board_1",
    source_column_id: "col_ready",
    fingerprint: "sha256:route"
  };

  store.recordStartupValidation({
    warnings: [{ code: "ENTROPY_UNKNOWN", message: "Entropy settings were not visible." }],
    errors: [{ code: "MANAGED_WEBHOOK_MISCONFIGURED", message: "Webhook setup is invalid." }]
  });
  store.updateRunnerHealth({ status: "ready", kind: "cli_app_server" });
  store.setRoutes([route]);
  store.recordPoll({
    startedAt: "2026-04-29T12:01:00.000Z",
    completedAt: "2026-04-29T12:01:02.000Z"
  });
  store.recordClaim({
    id: "claim_1",
    card_id: "card_running",
    status: "claimed",
    expires_at: "2026-04-29T12:16:00.000Z"
  });

  store.queueRun({ id: "run_queued", card: { id: "card_queued", number: 10 }, board_id: "board_1", route });
  store.startRun({
    id: "run_running",
    attempt_id: "attempt_running",
    card: { id: "card_running", number: 11 },
    board_id: "board_1",
    route,
    claim: { id: "claim_1" },
    workspace: { key: "workspace_running", path: "/tmp/workspace-running" },
    runner: { kind: "cli_app_server" },
    session: { session_id: "session_running" }
  });
  store.startRun({ id: "run_completed", card: { id: "card_completed" }, board_id: "board_1", route });
  store.completeRun("run_completed", {
    proof: { file: "proof/run_completed.json", digest: "sha256:proof" },
    result_comment_id: "comment_1"
  });
  store.startRun({ id: "run_failed", card: { id: "card_failed" }, board_id: "board_1", route });
  store.failRun("run_failed", { code: "RUNNER_ERROR", message: "runner failed" });
  store.startRun({ id: "run_cancelled", card: { id: "card_cancelled" }, board_id: "board_1", route });
  store.cancelRun("run_cancelled", "card closed");

  const snapshot = store.status();
  assert.equal(snapshot.instance.id, "instance-a");
  assert.equal(snapshot.instance.label, "local");
  assert.deepEqual(snapshot.watched_boards.map((board) => board.id), ["board_1"]);
  assert.equal(snapshot.poll.last_completed_at, "2026-04-29T12:01:02.000Z");
  assert.deepEqual(snapshot.routes.map((candidate) => candidate.id), [route.id]);
  assert.deepEqual(snapshot.runs.queued.map((run) => run.id), ["run_queued"]);
  assert.deepEqual(snapshot.runs.running.map((run) => run.id), ["run_running"]);
  assert.deepEqual(snapshot.runs.completed.map((run) => run.id), ["run_completed"]);
  assert.deepEqual(snapshot.runs.failed.map((run) => run.id), ["run_failed"]);
  assert.deepEqual(snapshot.runs.cancelled.map((run) => run.id), ["run_cancelled"]);
  assert.equal(snapshot.claims[0].id, "claim_1");
  assert.equal(snapshot.runs.completed[0].proof.digest, "sha256:proof");
  assert.equal(snapshot.runs.failed[0].last_error.code, "RUNNER_ERROR");
  assert.equal(snapshot.runs.cancelled[0].cancellation_reason, "card closed");

  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-status-"));
  const snapshotPath = join(dir, "nested", "latest.json");
  const written = await store.writeSnapshot(snapshotPath);
  const onDisk = JSON.parse(await readFile(snapshotPath, "utf8"));

  assert.equal(written.path, snapshotPath);
  assert.equal(onDisk.instance.id, "instance-a");
  assert.deepEqual(onDisk.runs.completed.map((run) => run.id), ["run_completed"]);
});

test("status snapshot exposes startup recovery and readiness blocks on recovery errors", () => {
  const store = createStore();
  store.updateRunnerHealth({ status: "ready", kind: "cli_app_server" });

  store.recordStartupRecovery({
    stale_instances: {
      removed_stale_instances: [{ instance_id: "instance-old" }],
      live_instances: [{ instance_id: "instance-live" }]
    },
    interrupted_attempts: [{ attempt_id: "attempt_1", run_id: "run_1" }],
    preserved_workspaces: [{ workspace_key: "workspace_1", code: "WORKSPACE_GUARD_MISSING" }],
    claims: {
      recoverable_expired_self_claims: [{ claim_id: "claim_expired" }],
      live_self_claim_warnings: [{ claim_id: "claim_live" }]
    },
    cleanup_recovery: {
      recoverable: [{ attempt_id: "attempt_cleanup" }],
      preserved: [{ attempt_id: "attempt_preserved" }]
    },
    warnings: [{ code: "WORKSPACE_GUARD_MISSING", message: "Workspace guard is missing." }],
    errors: [{ code: "INSTANCE_REGISTRY_LIVE_SAME_INSTANCE", message: "Same instance is already live." }]
  });

  const snapshot = store.status();
  assert.equal(snapshot.startup_recovery.interrupted_attempts[0].attempt_id, "attempt_1");
  assert.equal(snapshot.startup_recovery.preserved_workspaces[0].workspace_key, "workspace_1");
  assert.equal(snapshot.startup_recovery.cleanup_recovery.recoverable[0].attempt_id, "attempt_cleanup");
  assert.equal(snapshot.readiness.ready, false);
  assert.equal(snapshot.readiness.blockers[0].code, "STARTUP_RECOVERY_ERRORS");
});

test("status snapshots expose orchestrator lifecycle recovery, retry, stall, claim renewal, and cancellation details", () => {
  const store = createStore();

  store.recordLifecycleSnapshot({
    recovery_report: {
      interrupted_attempts: [{ run_id: "run_old", recovered_status: "interrupted" }],
      preserved_workspaces: [{ workspace_key: "workspace_old", reason: "interrupted" }],
      claims: [{ claim_id: "claim_old", card_id: "card_old" }]
    },
    active_runs: [{ run_id: "run_active", card_id: "card_active", claim_id: "claim_active" }],
    claims: [{ claim_id: "claim_active", card_id: "card_active", status: "claimed" }],
    claim_renewals: [{ run_id: "run_active", status: "renewed" }],
    retry_queue: [{ run_id: "run_retry", attempt_number: 2, backoff_ms: 1000 }],
    stalled_runs: [{ run_id: "run_stalled", stalled_at: "2026-04-29T12:05:00.000Z" }],
    cancellations: [{ run_id: "run_cancelled", reason: "route_fingerprint_mismatch" }],
    recent_failures: [{ run_id: "run_failed", error: { code: "RUNNER_ERROR", message: "runner failed" } }]
  });

  const snapshot = store.status();
  assert.equal(snapshot.recovery_report.interrupted_attempts[0].run_id, "run_old");
  assert.equal(snapshot.lifecycle.active_runs[0].run_id, "run_active");
  assert.equal(snapshot.lifecycle.claims[0].claim_id, "claim_active");
  assert.equal(snapshot.claim_renewals[0].status, "renewed");
  assert.equal(snapshot.retry_queue[0].attempt_number, 2);
  assert.equal(snapshot.stalled_runs[0].run_id, "run_stalled");
  assert.equal(snapshot.cancellations[0].reason, "route_fingerprint_mismatch");
  assert.equal(snapshot.recent_failures[0].error.code, "RUNNER_ERROR");
});

test("status exposes SPEC 22 metadata surfaces and bounds recent history", () => {
  const store = createStore();

  store.updateRunnerHealth({ status: "ready", kind: "cli_app_server", checked_at: "2026-04-29T12:00:00.000Z" });
  store.recordManagedWebhookStatus({
    enabled: true,
    by_board: { board_1: { id: "webhook_1", status: "inactive" } },
    recent_delivery_errors: [
      { board_id: "board_1", webhook_id: "webhook_1", code: "DELIVERY_FAILED", message: "last delivery failed" }
    ]
  });
  store.recordTokenRateLimit({
    available: true,
    fizzy: { limit: 100, remaining: 42, reset_at: "2026-04-29T13:00:00.000Z" },
    runner: { available: false, reason: "runner did not report token metadata" }
  });
  store.recordRetryQueue([{ run_id: "run_retry", card_id: "card_retry", next_attempt_at: "2026-04-29T12:10:00.000Z" }]);
  store.recordCleanupState({
    status: "preserved",
    workspace_path: "/tmp/workspace-running",
    reason: "proof not recorded"
  });
  store.recordEtagCache({ hits: 5, misses: 2, invalid: 1 });
  store.recordWorkpad({
    card_id: "card_running",
    comment_id: "comment_workpad",
    updated_at: "2026-04-29T12:04:00.000Z"
  });

  for (let index = 0; index < 55; index += 1) {
    store.startRun({ id: `run_done_${index}`, card: { id: `card_done_${index}` } });
    store.completeRun(`run_done_${index}`, { completed_at: `2026-04-29T12:${String(index).padStart(2, "0")}:00.000Z` });
    store.startRun({ id: `run_failed_${index}`, card: { id: `card_failed_${index}` } });
    store.failRun(`run_failed_${index}`, {
      code: "RUNNER_ERROR",
      message: `failed ${index}`,
      failed_at: `2026-04-29T12:${String(index).padStart(2, "0")}:30.000Z`
    });
  }

  const snapshot = store.status();

  assert.equal(snapshot.managed_webhooks.by_board.board_1.status, "inactive");
  assert.equal(snapshot.webhook.recent_delivery_errors[0].code, "DELIVERY_FAILED");
  assert.equal(snapshot.token_rate_limit.available, true);
  assert.equal(snapshot.token_rate_limit.fizzy.remaining, 42);
  assert.equal(snapshot.retry_queue[0].run_id, "run_retry");
  assert.equal(snapshot.cleanup_state.status, "preserved");
  assert.deepEqual(snapshot.etag_cache, { hits: 5, misses: 2, invalid: 1 });
  assert.equal(snapshot.workpads[0].comment_id, "comment_workpad");
  assert.equal(snapshot.recent_completions.length, 50);
  assert.equal(snapshot.recent_completions[0].run_id, "run_done_5");
  assert.equal(snapshot.recent_completions.at(-1).run_id, "run_done_54");
  assert.equal(snapshot.recent_failures.length, 50);
  assert.equal(snapshot.recent_failures[0].run_id, "run_failed_5");
  assert.equal(snapshot.recent_failures.at(-1).run_id, "run_failed_54");
});

test("status defaults token/rate metadata and webhook warnings to unavailable or empty", () => {
  const snapshot = createStore().status();

  assert.deepEqual(snapshot.webhook.recent_delivery_errors, []);
  assert.deepEqual(snapshot.managed_webhooks.recent_delivery_errors, []);
  assert.equal(snapshot.token_rate_limit.available, false);
  assert.equal(snapshot.token_rate_limit.reason, "not_recorded");
});

test("run attempt records are written atomically under observability state_dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-run-registry-"));
  const store = createStatusStore({
    instance: { id: "instance-a", label: "local" },
    startedAt: "2026-04-29T12:00:00.000Z",
    config: {
      ...configFixture(),
      observability: { state_dir: dir }
    }
  });

  const run = store.startRun({
    id: "run_1",
    attempt_id: "attempt_1",
    card: { id: "card_1", number: 42 },
    board_id: "board_1",
    route: {
      id: "route_1",
      fingerprint: "sha256:route"
    },
    card_digest: "sha256:card",
    claim: { id: "claim_1" },
    workspace: {
      path: "/tmp/workspace",
      identity_digest: "sha256:workspace"
    },
    runner: { kind: "cli_app_server" },
    session: { session_id: "session_1" },
    turn: { turn_id: "turn_1" },
    proof: { file: "/tmp/proof.json", digest: "sha256:proof" },
    result_comment_id: "comment_1",
    cleanup_state: { status: "preserved" }
  });

  const written = await store.writeRunAttemptRecord(run);
  const record = JSON.parse(await readFile(written.path, "utf8"));
  const runFiles = await readdir(join(dir, "runs"));

  assert.equal(written.path, join(dir, "runs", "attempt_1.json"));
  assert.equal(record.schema_version, "fizzy-symphony-run-attempt-v1");
  assert.equal(record.run_id, "run_1");
  assert.equal(record.attempt_id, "attempt_1");
  assert.equal(record.card_id, "card_1");
  assert.equal(record.card_number, 42);
  assert.equal(record.board_id, "board_1");
  assert.equal(record.route_id, "route_1");
  assert.equal(record.route_fingerprint, "sha256:route");
  assert.equal(record.card_digest, "sha256:card");
  assert.equal(record.workspace_identity_digest, "sha256:workspace");
  assert.equal(record.workspace_path, "/tmp/workspace");
  assert.equal(record.claim_id, "claim_1");
  assert.equal(record.runner_kind, "cli_app_server");
  assert.equal(record.session_id, "session_1");
  assert.equal(record.turn_id, "turn_1");
  assert.equal(record.status, "running");
  assert.equal(record.proof_path, "/tmp/proof.json");
  assert.equal(record.proof_digest, "sha256:proof");
  assert.equal(record.result_comment_id, "comment_1");
  assert.equal(record.cleanup_state.status, "preserved");
  assert.deepEqual(runFiles, ["attempt_1.json"]);
});
