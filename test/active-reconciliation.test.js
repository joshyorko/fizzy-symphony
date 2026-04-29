import test from "node:test";
import assert from "node:assert/strict";

import { runReconciliationTick } from "../src/reconciler.js";
import { createStatusStore } from "../src/status.js";

function configFixture(overrides = {}) {
  return {
    instance: { id: "instance-a", label: "local" },
    boards: { entries: [{ id: "board_1", label: "Agents", enabled: true }] },
    polling: { interval_ms: 30000 },
    webhook: { enabled: false },
    agent: { max_concurrent: 2, max_turns: 1 },
    runner: { preferred: "cli_app_server", cancel_timeout_ms: 50 },
    observability: {},
    ...overrides
  };
}

function statusStore(config = configFixture()) {
  const store = createStatusStore({
    instance: { id: "instance-a", label: "local" },
    startedAt: "2026-04-29T12:00:00.000Z",
    config
  });
  store.updateRunnerHealth({ status: "ready", kind: "cli_app_server" });
  return store;
}

function routeFixture(overrides = {}) {
  return {
    id: "route_1",
    board_id: "board_1",
    source_column_id: "col_ready",
    fingerprint: "sha256:route",
    workspace: "app",
    completion: { policy: "comment_once" },
    ...overrides
  };
}

function cardFixture(overrides = {}) {
  return {
    id: "card_1",
    number: 1,
    board_id: "board_1",
    column_id: "col_ready",
    status: "open",
    title: "Card 1",
    tags: [],
    ...overrides
  };
}

function activeRunFixture(overrides = {}) {
  const route = routeFixture(overrides.route ?? {});
  const card = cardFixture(overrides.card ?? {});
  const claim = {
    id: "claim_card_1",
    claim_id: "claim_card_1",
    card_id: card.id,
    board_id: card.board_id,
    route_id: route.id,
    route_fingerprint: route.fingerprint,
    run_id: "run_card_1",
    attempt_id: "attempt_card_1",
    lease_expires_at: "2026-04-29T12:15:00.000Z",
    status: "claimed",
    ...(overrides.claim ?? {})
  };

  return {
    id: claim.run_id,
    attempt_id: claim.attempt_id,
    card,
    board_id: card.board_id,
    route,
    claim,
    workspace: { key: "workspace_card_1", path: "/tmp/workspace-card-1", identity_digest: "sha256:workspace" },
    runner: { kind: "cli_app_server" },
    session: { session_id: "session_card_1", process_owned: true },
    turn: { turn_id: "turn_card_1", session_id: "session_card_1" },
    ...(overrides.run ?? {})
  };
}

function fixedNow() {
  return new Date("2026-04-29T12:02:00.000Z");
}

function activeReconciliationDeps({
  refreshedCard,
  routerDecision,
  claimRenewal = { renewed: true },
  cancelResult = { type: "CancelResult", status: "cancelled", success: true },
  stopResult = { type: "StopSessionResult", status: "stopped" },
  terminateResult = { type: "TerminateProcessResult", status: "terminated" },
  discoverCards = []
} = {}) {
  const calls = [];

  return {
    calls,
    fizzy: {
      async refreshActiveCards({ activeRuns }) {
        calls.push(`refresh:${activeRuns.map((run) => run.card_id).join(",")}`);
        return [refreshedCard ?? cardFixture()];
      },
      async discoverCandidates() {
        calls.push("discover");
        return discoverCards;
      },
      async postCancellationComment({ finalStatus, reason, cancellation }) {
        calls.push(`comment:${finalStatus}:${reason}`);
        assert.equal(cancellation.states.cancel_requested.status, "done");
        assert.equal(cancellation.states.workspace_preserved.status, "preserved");
        return { id: `comment_${finalStatus}` };
      }
    },
    router: {
      async validateCandidate({ card, activeRun }) {
        calls.push(activeRun ? `route-active:${card.id}` : `route-candidate:${card.id}`);
        if (activeRun) {
          return routerDecision ?? { action: "spawn", card, route: activeRun.route };
        }
        return { action: "spawn", card, route: routeFixture(), prompt: "do work" };
      }
    },
    claims: {
      async renew({ run }) {
        calls.push(`renew:${run.id}`);
        return claimRenewal;
      },
      async acquire({ card }) {
        calls.push(`claim:${card.id}`);
        return {
          acquired: true,
          claim: { id: `claim_${card.id}`, run_id: `run_${card.id}`, attempt_id: `attempt_${card.id}` }
        };
      },
      async release({ status, run }) {
        calls.push(`release:${run.id}:${status}`);
        assert.equal(status, "cancelled");
        return { released: true, status };
      }
    },
    workspaceManager: {
      async preserve({ run, reason, finalStatus }) {
        calls.push(`preserve:${run.id}:${finalStatus}:${reason}`);
        return { status: "preserved", workspace_path: run.workspace_path, reason };
      },
      async prepare() {
        throw new Error("new dispatch should not prepare a workspace in active reconciliation tests");
      }
    },
    workflowLoader: {},
    runner: {
      async cancel(turn, reason) {
        calls.push(`cancel:${turn.turn_id}:${reason}`);
        return cancelResult;
      },
      async stopSession(session) {
        calls.push(`stop:${session.session_id}`);
        return stopResult;
      },
      async terminateOwnedProcess(session) {
        calls.push(`terminate:${session.session_id}`);
        return terminateResult;
      }
    }
  };
}

test("runReconciliationTick cancels an active run when the refreshed card is closed", async () => {
  const config = configFixture();
  const status = statusStore(config);
  const activeRun = status.startRun(activeRunFixture());
  const deps = activeReconciliationDeps({ refreshedCard: cardFixture({ closed: true }) });

  const result = await runReconciliationTick({ config, status, now: fixedNow, ...deps });

  assert.equal(result.cancelled, 1);
  assert.deepEqual(deps.calls, [
    "refresh:card_1",
    "renew:run_card_1",
    "cancel:turn_card_1:card_closed",
    "release:run_card_1:cancelled",
    "preserve:run_card_1:cancelled:card_closed",
    "comment:cancelled:card_closed",
    "discover"
  ]);

  const cancelled = status.status().runs.cancelled[0];
  assert.equal(cancelled.id, activeRun.id);
  assert.equal(cancelled.cancellation.reason, "card_closed");
  assert.equal(cancelled.cancellation.states.runner_cancel_sent.status, "succeeded");
  assert.equal(cancelled.cancellation.states.claim_cancelled.status, "succeeded");
  assert.equal(cancelled.cancellation.workspace_preserved, true);
  assert.equal(cancelled.cancellation_comment_id, "comment_cancelled");
});

for (const [name, card, reason] of [
  ["postponed", cardFixture({ postponed: true }), "card_postponed"],
  ["auto-postponed", cardFixture({ auto_postponed: true }), "card_auto_postponed"]
]) {
  test(`runReconciliationTick cancels an active run when the refreshed card is ${name}`, async () => {
    const config = configFixture();
    const status = statusStore(config);
    status.startRun(activeRunFixture());
    const deps = activeReconciliationDeps({ refreshedCard: card });

    const result = await runReconciliationTick({ config, status, now: fixedNow, ...deps });

    assert.equal(result.cancelled, 1);
    assert.ok(deps.calls.includes(`cancel:turn_card_1:${reason}`));
    assert.equal(status.status().runs.cancelled[0].cancellation.reason, reason);
  });
}

for (const [name, card, reason] of [
  ["moved out of the routed column", cardFixture({ column_id: "col_triage" }), "card_left_routed_column"],
  ["moved off the watched board", cardFixture({ board_id: "board_other" }), "card_board_changed"]
]) {
  test(`runReconciliationTick cancels an active run when the refreshed card is ${name}`, async () => {
    const config = configFixture();
    const status = statusStore(config);
    status.startRun(activeRunFixture());
    const deps = activeReconciliationDeps({ refreshedCard: card });

    const result = await runReconciliationTick({ config, status, now: fixedNow, ...deps });

    assert.equal(result.cancelled, 1);
    assert.ok(deps.calls.includes(`cancel:turn_card_1:${reason}`));
    assert.equal(status.status().runs.cancelled[0].cancellation.reason, reason);
  });
}

test("runReconciliationTick preempts an active run when the route fingerprint changes and skips same-card redispatch", async () => {
  const config = configFixture();
  const status = statusStore(config);
  const activeRun = status.startRun(activeRunFixture());
  const newRoute = routeFixture({ fingerprint: "sha256:new-route" });
  const deps = activeReconciliationDeps({
    refreshedCard: cardFixture(),
    routerDecision: { action: "spawn", card: cardFixture(), route: newRoute },
    discoverCards: [cardFixture()]
  });

  const result = await runReconciliationTick({ config, status, now: fixedNow, ...deps });

  assert.equal(result.preempted, 1);
  assert.equal(result.dispatched, 0);
  assert.equal(deps.calls.includes("claim:card_1"), false);
  assert.ok(deps.calls.includes("route-active:card_1"));

  const preempted = status.status().runs.preempted[0];
  assert.equal(preempted.id, activeRun.id);
  assert.equal(preempted.cancellation.final_status, "preempted");
  assert.equal(preempted.cancellation.reason, "route_fingerprint_changed");
  assert.equal(preempted.cancellation.previous_route_fingerprint, "sha256:route");
  assert.equal(preempted.cancellation.current_route_fingerprint, "sha256:new-route");
});

test("runReconciliationTick cancels and preserves when active claim renewal fails", async () => {
  const config = configFixture();
  const status = statusStore(config);
  status.startRun(activeRunFixture());
  const deps = activeReconciliationDeps({
    refreshedCard: cardFixture(),
    claimRenewal: { renewed: false, error: { code: "LEASE_EXPIRED", message: "lease expired" } }
  });

  const result = await runReconciliationTick({ config, status, now: fixedNow, ...deps });

  assert.equal(result.cancelled, 1);
  assert.ok(deps.calls.includes("cancel:turn_card_1:claim_renewal_failed"));
  assert.equal(status.status().runs.cancelled[0].cancellation.reason, "claim_renewal_failed");
});

test("runReconciliationTick escalates from Runner.cancel failure to stopSession and owned process termination", async () => {
  const config = configFixture();
  const status = statusStore(config);
  status.startRun(activeRunFixture());
  const deps = activeReconciliationDeps({
    refreshedCard: cardFixture({ closed: true }),
    cancelResult: { type: "CancelResult", status: "failed", success: false },
    stopResult: { type: "StopSessionResult", status: "stopped" }
  });

  const result = await runReconciliationTick({ config, status, now: fixedNow, ...deps });

  assert.equal(result.cancelled, 1);
  assert.ok(deps.calls.includes("stop:session_card_1"));
  assert.ok(deps.calls.includes("terminate:session_card_1"));

  const cancellation = status.status().runs.cancelled[0].cancellation;
  assert.equal(cancellation.states.runner_cancel_sent.status, "failed");
  assert.equal(cancellation.states.session_stopped.status, "succeeded");
  assert.equal(cancellation.states.process_terminated.status, "succeeded");
  assert.equal(cancellation.manual_intervention_required, false);
});

test("runReconciliationTick times out Runner.cancel, preserves unknown ownership, and surfaces manual intervention", async () => {
  const config = configFixture({ runner: { preferred: "cli_app_server", cancel_timeout_ms: 1 } });
  const status = statusStore(config);
  status.startRun(activeRunFixture({
    run: { session: { session_id: "session_card_1" } }
  }));
  const deps = activeReconciliationDeps({
    refreshedCard: cardFixture({ closed: true }),
    cancelResult: new Promise(() => {}),
    stopResult: { type: "StopSessionResult", status: "failed" }
  });

  const result = await runReconciliationTick({ config, status, now: fixedNow, ...deps });

  assert.equal(result.cancelled, 1);
  assert.equal(deps.calls.includes("terminate:session_card_1"), false);

  const cancellation = status.status().runs.cancelled[0].cancellation;
  assert.equal(cancellation.states.runner_cancel_sent.status, "timeout");
  assert.equal(cancellation.states.session_stopped.status, "failed");
  assert.equal(cancellation.states.workspace_preserved.status, "preserved");
  assert.equal(cancellation.manual_intervention_required, true);
});
