import test from "node:test";
import assert from "node:assert/strict";

import { projectV1StatusToV2 } from "../../src/v2/daemon/status-bridge.ts";

test("projectV1StatusToV2 maps the live daemon snapshot into cockpit status", () => {
  const status = projectV1StatusToV2({
    schema_version: "fizzy-symphony-status-v1",
    instance: {
      id: "instance-a",
      label: "local",
      pid: 123,
      started_at: "2026-05-31T12:00:00.000Z",
      endpoint: { base_url: "http://127.0.0.1:4567" }
    },
    readiness: {
      ready: false,
      blockers: [{ code: "RUNNER_NOT_READY", message: "Runner not ready." }],
      runner_health: { status: "unavailable" }
    },
    runner_health: { status: "unavailable", kind: "cli_app_server" },
    watched_boards: [{ id: "board_1", label: "Agents" }],
    routes: [{
      id: "route_1",
      board_id: "board_1",
      source_column_id: "col_ready",
      source_column_name: "Ready for Agents",
      golden_card_id: "golden_1",
      golden_card_number: 1,
      backend: "codex",
      model: "gpt-5.5"
    }],
    runs: {
      queued: [{ id: "run_q", card_id: "card_q", card_number: 41, board_id: "board_1", route_id: "route_1", status: "queued" }],
      running: [{
        id: "run_1",
        card_id: "card_1",
        card_number: 42,
        board_id: "board_1",
        route_id: "route_1",
        status: "running",
        session_id: "session_1",
        turn_id: "turn_1",
        workspace_key: "ws_1",
        workspace_path: "/tmp/ws",
        last_error: { code: "X", message: "bad" }
      }],
      completed: [],
      failed: [],
      cancelled: [],
      preempted: []
    },
    claims: [{ id: "claim_1", card_id: "card_1", status: "claimed", workspace_key: "ws_1" }],
    recovery_report: { preserved_workspaces: [{ workspace_key: "ws_old", workspace_path: "/tmp/old" }] },
    cleanup_state: { status: "preserved", workspace_key: "ws_1", workspace_path: "/tmp/ws", reason: "dirty" },
    retry_queue: [{ run_id: "run_q", card_id: "card_q", attempt_number: 2, next_attempt_at: "2026-05-31T12:05:00.000Z" }],
    capacity_refusals: [{ card_id: "card_2", route_id: "route_1", reason: "agent.max_concurrent", refused_at: "2026-05-31T12:01:00.000Z" }],
    recent_warnings: [{ code: "WARN", message: "Careful.", severity: "warning", recorded_at: "2026-05-31T12:02:00.000Z" }],
    recent_failures: [{ run_id: "run_1", card_id: "card_1", error: { code: "FAIL", message: "Failed." }, failed_at: "2026-05-31T12:03:00.000Z" }],
    last_updated_at: "2026-05-31T12:04:00.000Z"
  });

  assert.equal(status.schemaVersion, "fizzy-symphony-status-v2");
  assert.equal(status.instance.endpoint, "http://127.0.0.1:4567");
  assert.equal(status.readiness.state, "blocked");
  assert.equal(status.readiness.runnerStatus, "unavailable");
  assert.deepEqual(status.boards, [{ id: "board_1", name: "Agents", routeIds: ["route_1"], activeCardCount: 2, goldenCardCount: 1 }]);
  assert.equal(status.routes[0].disabledReason, "Runner unavailable");
  assert.equal(status.cards.find((card) => card.id === "card_1").runId, "run_1");
  assert.equal(status.runs.running[0].turnId, "turn_1");
  assert.equal(status.worktrees.find((worktree) => worktree.workspaceKey === "ws_1").preserved, true);
  assert.equal(status.retryQueue[0].attempt, 2);
  assert.equal(status.doctor.goalClosable, false);
  assert.ok(status.recentEvents.some((event) => event.type === "v1.recent_failure"));
});

test("projectV1StatusToV2 preserves route disabled reasons from non-codex backends", () => {
  const status = projectV1StatusToV2({
    instance: { id: "instance-a" },
    readiness: { ready: true, blockers: [] },
    runner_health: { status: "ready", kind: "cli_app_server" },
    watched_boards: [{ id: "board_1", label: "Agents" }],
    routes: [{
      id: "route_claude",
      board_id: "board_1",
      source_column_id: "col_ready",
      source_column_name: "Ready for Agents",
      golden_card_id: "golden_1",
      backend: "claude",
      enabled: false,
      disabledReason: "Execution for backend claude is not wired yet."
    }],
    runs: { queued: [], running: [], completed: [], failed: [], cancelled: [], preempted: [] }
  });

  assert.equal(status.routes[0].enabled, false);
  assert.equal(status.routes[0].backend, "claude");
  assert.equal(status.routes[0].disabledReason, "Execution for backend claude is not wired yet.");
});
