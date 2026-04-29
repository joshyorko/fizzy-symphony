import test from "node:test";
import assert from "node:assert/strict";

import { createClaimMarker } from "../src/claims.js";
import { createOrchestratorState } from "../src/orchestrator-state.js";

const START = Date.parse("2026-04-29T12:00:00.000Z");

function clockFixture() {
  let time = START;
  return {
    now() {
      return new Date(time);
    },
    advance(ms) {
      time += ms;
      return new Date(time);
    }
  };
}

function schedulerFixture() {
  let nextId = 1;
  const timers = new Map();

  return {
    setTimeout(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, callback, delayMs, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.cleared = true;
    },
    pending() {
      return [...timers.values()].filter((timer) => !timer.cleared);
    },
    async fire(id) {
      const timer = timers.get(id);
      assert.ok(timer, `expected timer ${id} to exist`);
      return timer.callback();
    }
  };
}

function configFixture(overrides = {}) {
  return {
    instance: { id: "instance-a" },
    agent: {
      max_concurrent: 2,
      stall_timeout_ms: 5000,
      max_retry_backoff_ms: 2500,
      ...(overrides.agent ?? {})
    },
    claims: {
      lease_ms: 900000,
      renew_interval_ms: 300000,
      ...(overrides.claims ?? {})
    },
    ...overrides
  };
}

function cardFixture(id = "card_1", number = 1) {
  return {
    id,
    number,
    board_id: "board_1",
    column_id: "col_ready",
    status: "open"
  };
}

function routeFixture(overrides = {}) {
  return {
    id: "route_1",
    board_id: "board_1",
    source_column_id: "col_ready",
    fingerprint: "sha256:route",
    workspace: "app",
    ...overrides
  };
}

function claimFixture(overrides = {}) {
  return {
    id: "claim_1",
    claim_id: "claim_1",
    run_id: "run_1",
    attempt_id: "attempt_1",
    route_fingerprint: "sha256:route",
    lease_expires_at: "2026-04-29T12:15:00.000Z",
    ...overrides
  };
}

function workspaceFixture(overrides = {}) {
  return {
    key: "workspace_1",
    path: "/tmp/fizzy-symphony/workspace_1",
    identity_digest: "sha256:workspace",
    ...overrides
  };
}

test("orchestrator state schedules capped retry backoff and records terminal exhaustion", async () => {
  const clock = clockFixture();
  const scheduler = schedulerFixture();
  const state = createOrchestratorState({
    config: configFixture(),
    clock,
    scheduler
  });

  state.startRun({
    run_id: "run_1",
    attempt_id: "attempt_1",
    attempt_number: 1,
    card: cardFixture(),
    route: routeFixture(),
    claim: claimFixture(),
    workspace: workspaceFixture()
  });

  state.recordFailure("run_1", { code: "RUNNER_ERROR", message: "first turn failed" }, {
    retryable: true,
    failure_kind: "runner"
  });

  let snapshot = state.snapshot();
  assert.equal(snapshot.retry_queue.length, 1);
  assert.equal(snapshot.retry_queue[0].attempt_number, 2);
  assert.equal(snapshot.retry_queue[0].backoff_ms, 1000);
  assert.equal(snapshot.retry_queue[0].next_retry_at, "2026-04-29T12:00:01.000Z");
  assert.equal(snapshot.retry_queue[0].workspace_preserved, true);

  const retryTimer = scheduler.pending().find((timer) => timer.delayMs === 1000);
  clock.advance(1000);
  await scheduler.fire(retryTimer.id);
  assert.equal(state.snapshot().retry_queue[0].status, "ready");

  state.startRun({
    run_id: "run_2",
    attempt_id: "attempt_2",
    attempt_number: 2,
    card: cardFixture(),
    route: routeFixture(),
    claim: claimFixture({ run_id: "run_2", attempt_id: "attempt_2" }),
    workspace: workspaceFixture()
  });
  state.recordFailure("run_2", { code: "RUNNER_ERROR", message: "second turn failed" }, {
    retryable: true,
    failure_kind: "runner"
  });

  snapshot = state.snapshot();
  assert.equal(snapshot.retry_queue.at(-1).attempt_number, 3);
  assert.equal(snapshot.retry_queue.at(-1).backoff_ms, 2000);

  state.startRun({
    run_id: "run_3",
    attempt_id: "attempt_3",
    attempt_number: 3,
    card: cardFixture(),
    route: routeFixture(),
    claim: claimFixture({ run_id: "run_3", attempt_id: "attempt_3" }),
    workspace: workspaceFixture()
  });
  state.recordFailure("run_3", { code: "RUNNER_ERROR", message: "third turn failed" }, {
    retryable: true,
    failure_kind: "runner"
  });

  snapshot = state.snapshot();
  assert.equal(snapshot.retry_queue.filter((entry) => entry.status !== "stale").length, 2);
  assert.equal(snapshot.recent_failures.at(-1).terminal, true);
  assert.equal(snapshot.recent_failures.at(-1).retry_exhausted, true);
});

test("stale retry, renewal, and stall timer callbacks cannot mutate a replacement attempt", async () => {
  const clock = clockFixture();
  const scheduler = schedulerFixture();
  const renewals = [];
  const cancellations = [];
  const state = createOrchestratorState({
    config: configFixture({
      agent: { stall_timeout_ms: 900 },
      claims: { renew_interval_ms: 700 }
    }),
    clock,
    scheduler,
    claims: {
      async renew({ run }) {
        renewals.push(run.run_id);
        return { renewed: true, lease_expires_at: "2026-04-29T12:15:00.000Z" };
      }
    },
    runner: {
      async cancel(turn, reason) {
        cancellations.push({ turn, reason });
        return { status: "cancelled" };
      }
    }
  });

  state.startRun({
    run_id: "run_1",
    attempt_id: "attempt_1",
    attempt_number: 1,
    card: cardFixture(),
    route: routeFixture(),
    claim: claimFixture(),
    workspace: workspaceFixture(),
    turn: { turn_id: "turn_1" }
  });
  const staleRenewal = scheduler.pending().find((timer) => timer.delayMs === 700);
  const staleStall = scheduler.pending().find((timer) => timer.delayMs === 900);

  state.recordFailure("run_1", { code: "RUNNER_ERROR", message: "retry me" }, {
    retryable: true,
    failure_kind: "runner"
  });
  const staleRetry = scheduler.pending().find((timer) => timer.delayMs === 1000);

  state.startRun({
    run_id: "run_2",
    attempt_id: "attempt_2",
    attempt_number: 2,
    card: cardFixture(),
    route: routeFixture(),
    claim: claimFixture({ run_id: "run_2", attempt_id: "attempt_2" }),
    workspace: workspaceFixture(),
    turn: { turn_id: "turn_2" }
  });

  clock.advance(5000);
  assert.deepEqual(await scheduler.fire(staleRenewal.id), { ignored: true, reason: "stale_timer" });
  assert.deepEqual(await scheduler.fire(staleStall.id), { ignored: true, reason: "stale_timer" });
  assert.deepEqual(await scheduler.fire(staleRetry.id), { ignored: true, reason: "stale_timer" });

  assert.deepEqual(renewals, []);
  assert.deepEqual(cancellations, []);
  assert.equal(state.snapshot().active_runs[0].run_id, "run_2");
});

test("stall detection uses runner activity, cancels the runner, preserves workspace, and retries", async () => {
  const clock = clockFixture();
  const scheduler = schedulerFixture();
  const cancellations = [];
  const state = createOrchestratorState({
    config: configFixture({
      agent: { stall_timeout_ms: 5000 }
    }),
    clock,
    scheduler,
    runner: {
      async cancel(turn, reason) {
        cancellations.push({ turn_id: turn.turn_id, reason });
        return { status: "cancelled" };
      }
    }
  });

  state.startRun({
    run_id: "run_1",
    attempt_id: "attempt_1",
    attempt_number: 1,
    card: cardFixture(),
    route: routeFixture(),
    claim: claimFixture(),
    workspace: workspaceFixture(),
    turn: { turn_id: "turn_1" }
  });
  state.recordRunnerActivity("run_1", { type: "assistant.delta", text: "still alive" });

  const firstStallTimer = scheduler.pending().find((timer) => timer.delayMs === 5000);
  clock.advance(5001);
  await scheduler.fire(firstStallTimer.id);

  const snapshot = state.snapshot();
  assert.deepEqual(cancellations, [{ turn_id: "turn_1", reason: "stalled" }]);
  assert.equal(snapshot.stalled_runs[0].run_id, "run_1");
  assert.equal(snapshot.stalled_runs[0].workspace_preserved, true);
  assert.equal(snapshot.retry_queue[0].reason, "stalled");
  assert.equal(snapshot.retry_queue[0].attempt_number, 2);
});

test("claim renewal failure past lease expiry cancels and preserves without retrying", async () => {
  const clock = clockFixture();
  const cancellations = [];
  const state = createOrchestratorState({
    config: configFixture({
      claims: { renew_interval_ms: 1000 }
    }),
    clock,
    claims: {
      async renew() {
        throw Object.assign(new Error("Fizzy is unavailable"), { code: "FIZZY_UNAVAILABLE" });
      }
    },
    runner: {
      async cancel(turn, reason) {
        cancellations.push({ turn_id: turn.turn_id, reason });
        return { status: "cancelled" };
      }
    }
  });

  state.startRun({
    run_id: "run_1",
    attempt_id: "attempt_1",
    attempt_number: 1,
    card: cardFixture(),
    route: routeFixture(),
    claim: claimFixture({ lease_expires_at: "2026-04-29T12:00:01.000Z" }),
    workspace: workspaceFixture(),
    turn: { turn_id: "turn_1" }
  });

  clock.advance(1001);
  await state.renewClaimNow("run_1");

  const snapshot = state.snapshot();
  assert.deepEqual(cancellations, [{ turn_id: "turn_1", reason: "claim_renewal_expired" }]);
  assert.equal(snapshot.cancellations[0].reason, "claim_renewal_expired");
  assert.equal(snapshot.cancellations[0].workspace_preserved, true);
  assert.equal(snapshot.claim_renewals[0].status, "failed_expired");
  assert.equal(snapshot.retry_queue.length, 0);
});

test("claim renewal false result past lease expiry cancels and does not report renewed", async () => {
  const clock = clockFixture();
  const cancellations = [];
  const state = createOrchestratorState({
    config: configFixture({
      claims: { renew_interval_ms: 1000 }
    }),
    clock,
    claims: {
      async renew({ claim }) {
        return {
          renewed: false,
          claim: {
            ...claim,
            expires_at: "2026-04-29T12:00:01.000Z",
            status: "renew_failed"
          },
          error: { code: "FIZZY_UNAVAILABLE", message: "post failed" }
        };
      }
    },
    runner: {
      async cancel(turn, reason) {
        cancellations.push({ turn_id: turn.turn_id, reason });
        return { status: "cancelled" };
      }
    }
  });

  state.startRun({
    run_id: "run_1",
    attempt_id: "attempt_1",
    attempt_number: 1,
    card: cardFixture(),
    route: routeFixture(),
    claim: claimFixture({ lease_expires_at: "2026-04-29T12:00:01.000Z" }),
    workspace: workspaceFixture(),
    turn: { turn_id: "turn_1" }
  });

  clock.advance(1001);
  const renewal = await state.renewClaimNow("run_1");

  assert.equal(renewal.status, "failed_expired");
  assert.deepEqual(cancellations, [{ turn_id: "turn_1", reason: "claim_renewal_expired" }]);
  assert.equal(state.snapshot().claim_renewals[0].status, "failed_expired");
  assert.equal(state.snapshot().cancellations[0].reason, "claim_renewal_expired");
});

test("active-card reconciliation cancels closed cards and route fingerprint mismatches", async () => {
  const cancellations = [];
  const state = createOrchestratorState({
    config: configFixture(),
    runner: {
      async cancel(turn, reason) {
        cancellations.push({ turn_id: turn.turn_id, reason });
        return { status: "cancelled" };
      }
    }
  });

  state.startRun({
    run_id: "run_closed",
    attempt_id: "attempt_closed",
    card: cardFixture("card_closed", 10),
    route: routeFixture(),
    claim: claimFixture({ run_id: "run_closed", attempt_id: "attempt_closed" }),
    workspace: workspaceFixture(),
    turn: { turn_id: "turn_closed" }
  });
  state.startRun({
    run_id: "run_mismatch",
    attempt_id: "attempt_mismatch",
    card: cardFixture("card_mismatch", 11),
    route: routeFixture(),
    claim: claimFixture({ run_id: "run_mismatch", attempt_id: "attempt_mismatch" }),
    workspace: workspaceFixture(),
    turn: { turn_id: "turn_mismatch" }
  });

  await state.reconcileActiveCards({
    cards: [
      { ...cardFixture("card_closed", 10), status: "closed" },
      { ...cardFixture("card_mismatch", 11), route_fingerprint: "sha256:new-route" }
    ]
  });

  assert.deepEqual(cancellations, [
    { turn_id: "turn_closed", reason: "card_left_eligible_state" },
    { turn_id: "turn_mismatch", reason: "route_fingerprint_mismatch" }
  ]);
  assert.deepEqual(
    state.snapshot().cancellations.map((cancellation) => cancellation.reason),
    ["card_left_eligible_state", "route_fingerprint_mismatch"]
  );
});

test("startup recovery reconstructs claims, interrupted attempts, workspaces, and instances", () => {
  const state = createOrchestratorState({
    config: configFixture({ instance: { id: "instance-a" } })
  });
  const marker = createClaimMarker({
    claim: {
      claim_id: "claim_1",
      run_id: "run_1",
      attempt_id: "attempt_1",
      lease_ms: 900000
    },
    card: { id: "card_1", board_id: "board_1", digest: "sha256:card" },
    route: routeFixture(),
    instance: { id: "instance-a", daemon_version: "0.1.0" },
    workspace: { key: "workspace_1", identity_digest: "sha256:workspace" },
    now: new Date(START)
  });

  const report = state.recoverStartup({
    claimCommentsByCard: {
      card_1: [{ id: "comment_1", body: marker.body, created_at: "2026-04-29T12:00:00.000Z" }]
    },
    runRecords: [
      {
        run_id: "run_1",
        attempt_id: "attempt_1",
        card_id: "card_1",
        status: "running",
        workspace_key: "workspace_1",
        workspace_path: "/tmp/fizzy-symphony/workspace_1"
      }
    ],
    workspaceMetadata: [
      {
        workspace_key: "workspace_1",
        workspace_path: "/tmp/fizzy-symphony/workspace_1",
        route_fingerprint: "sha256:route",
        guard_present: true
      }
    ],
    instanceRecords: [
      { instance_id: "instance-old", stale: true, path: "/tmp/instances/old.json" },
      { instance_id: "instance-a", stale: false, path: "/tmp/instances/current.json" }
    ]
  });

  assert.equal(report.claims[0].claim_id, "claim_1");
  assert.equal(report.interrupted_attempts[0].run_id, "run_1");
  assert.equal(report.interrupted_attempts[0].recovered_status, "interrupted");
  assert.equal(report.preserved_workspaces[0].workspace_key, "workspace_1");
  assert.equal(report.stale_instances[0].instance_id, "instance-old");
  assert.equal(state.snapshot().recovery_report.interrupted_attempts[0].run_id, "run_1");
});
