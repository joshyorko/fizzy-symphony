import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeStatus,
  deriveFactoryState,
  countDirtyWorktrees,
  countPreservedWorktrees
} from "../../src/v2/core/status.ts";
import { STATUS_SCHEMA_VERSION } from "../../src/v2/core/types.ts";

test("normalizeStatus stamps the v2 schema and fills empty collections", () => {
  const status = normalizeStatus({});
  assert.equal(status.schemaVersion, STATUS_SCHEMA_VERSION);
  assert.equal(status.instance.id, "unknown");
  assert.deepEqual(status.runs.running, []);
  assert.deepEqual(status.runs.queued, []);
  assert.deepEqual(status.boards, []);
  assert.deepEqual(status.warnings, []);
  assert.equal(status.doctor.goalClosable, true);
});

test("normalizeStatus does not mutate its input", () => {
  const input = { instance: { id: "x" }, runs: { running: [{ id: "r" }] } };
  const frozen = JSON.parse(JSON.stringify(input));
  normalizeStatus(input);
  assert.deepEqual(input, frozen);
});

test("normalizeStatus infers readiness state from blockers", () => {
  const status = normalizeStatus({ readiness: { blockers: [{ code: "X", message: "m" }] } });
  assert.equal(status.readiness.state, "blocked");
  assert.equal(status.readiness.ready, false);
});

test("deriveFactoryState maps readiness + activity to themed state", () => {
  assert.equal(deriveFactoryState(normalizeStatus({})), "unknown");
  assert.equal(
    deriveFactoryState(normalizeStatus({ readiness: { state: "ready", ready: true } })),
    "open"
  );
  assert.equal(
    deriveFactoryState(
      normalizeStatus({ readiness: { state: "ready", ready: true }, runs: { running: [{ id: "r", state: "running" }] } })
    ),
    "running"
  );
  assert.equal(
    deriveFactoryState(normalizeStatus({ readiness: { state: "blocked", ready: false, blockers: [{ code: "B", message: "m" }] } })),
    "blocked"
  );
  assert.equal(
    deriveFactoryState(normalizeStatus({ readiness: { state: "ready", ready: true, dispatchPaused: true } })),
    "locked"
  );
});

test("worktree counters", () => {
  const status = normalizeStatus({
    worktrees: [
      { workspaceKey: "a", path: "/a", dirty: true, preserved: true },
      { workspaceKey: "b", path: "/b", dirty: false, preserved: true },
      { workspaceKey: "c", path: "/c", dirty: false, preserved: false }
    ]
  });
  assert.equal(countDirtyWorktrees(status), 1);
  assert.equal(countPreservedWorktrees(status), 2);
});
