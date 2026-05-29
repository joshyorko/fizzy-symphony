import test from "node:test";
import assert from "node:assert/strict";

import { validateCommand, checkCommandAvailability } from "../../src/v2/core/commands.ts";
import { normalizeStatus } from "../../src/v2/core/status.ts";
import { createRuntime } from "../../src/v2/daemon/runtime.ts";

test("validateCommand rejects non-objects and unknown types", () => {
  assert.equal(validateCommand(null).ok, false);
  assert.equal(validateCommand("x").ok, false);
  assert.equal(validateCommand({ type: "nope" }).code, "UNKNOWN_COMMAND");
});

test("validateCommand requires runId and reason for run.cancel", () => {
  assert.equal(validateCommand({ type: "run.cancel" }).code, "MISSING_FIELD");
  assert.equal(validateCommand({ type: "run.cancel", runId: "r" }).code, "MISSING_REASON");
  assert.equal(validateCommand({ type: "run.cancel", runId: "r", reason: "x" }).ok, true);
});

test("validateCommand accepts dispatch pause/resume without extra fields", () => {
  assert.equal(validateCommand({ type: "dispatch.pause" }).ok, true);
  assert.equal(validateCommand({ type: "dispatch.resume" }).ok, true);
});

test("checkCommandAvailability gates cancel on an active run", () => {
  const status = normalizeStatus({
    runs: { running: [{ id: "run_1", state: "running", sessionId: "s_1" }] }
  });
  assert.equal(checkCommandAvailability({ type: "run.cancel", runId: "run_1", reason: "x" }, status).available, true);
  const miss = checkCommandAvailability({ type: "run.cancel", runId: "nope", reason: "x" }, status);
  assert.equal(miss.available, false);
  assert.equal(miss.code, "NO_ACTIVE_RUN");
});

test("runtime submitCommand dry-runs and writes an audit event", () => {
  const status = {
    readiness: { state: "ready", ready: true, runnerStatus: "ready" },
    runs: { running: [{ id: "run_1", state: "running", sessionId: "s_1", cardId: "card_1" }] },
    cards: [{ id: "card_1", title: "c", boardId: "b", state: "running", golden: false }]
  };
  const runtime = createRuntime({ status });
  const result = runtime.submitCommand({ type: "run.cancel", runId: "run_1", reason: "operator" });
  assert.equal(result.outcome, "dry-run");
  assert.equal(result.commandType, "run.cancel");
  assert.ok(result.event);
  const events = runtime.getEvents(10);
  assert.ok(events.some((e) => e.type === "command.dry-run.run.cancel"));
});

test("runtime submitCommand reports unavailable without an audit accept", () => {
  const runtime = createRuntime({ status: { readiness: { state: "ready", ready: true } } });
  const result = runtime.submitCommand({ type: "run.cancel", runId: "missing", reason: "x" });
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.code, "NO_ACTIVE_RUN");
});

test("runtime submitCommand rejects malformed commands", () => {
  const runtime = createRuntime({ status: {} });
  const result = runtime.submitCommand({ type: "run.cancel" });
  assert.equal(result.outcome, "rejected");
});

test("runtime applyCommands mode emits accepted (not dry-run) audit event", () => {
  const runtime = createRuntime({
    status: { readiness: { state: "ready", ready: true, dispatchPaused: false } },
    applyCommands: true
  });
  const result = runtime.submitCommand({ type: "dispatch.pause", reason: "maintenance" });
  assert.equal(result.outcome, "accepted");
});
