import test from "node:test";
import assert from "node:assert/strict";

import { validateCommand, checkCommandAvailability } from "../../src/v2/core/commands.ts";
import { normalizeStatus } from "../../src/v2/core/status.ts";
import { createRuntime } from "../../src/v2/daemon/runtime.ts";
import { applyCommandToStatus } from "../../src/v2/daemon/apply-command.ts";

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

test("applyCommands: dispatch.pause locks the factory and resume unlocks it", () => {
  const runtime = createRuntime({
    status: { readiness: { state: "ready", ready: true, dispatchPaused: false } },
    applyCommands: true
  });
  runtime.submitCommand({ type: "dispatch.pause", reason: "maintenance" });
  let status = runtime.getStatus();
  assert.equal(status.readiness.dispatchPaused, true);
  assert.equal(status.readiness.state, "locked");

  runtime.submitCommand({ type: "dispatch.resume", reason: "back" });
  status = runtime.getStatus();
  assert.equal(status.readiness.dispatchPaused, false);
  assert.equal(status.readiness.state, "ready");
});

test("applyCommands: run.cancel moves the run to cancelled and clears the card", () => {
  const runtime = createRuntime({
    status: {
      readiness: { state: "ready", ready: true, runnerStatus: "ready" },
      runs: { running: [{ id: "run_1", state: "running", sessionId: "s_1", cardId: "card_1" }] },
      cards: [{ id: "card_1", title: "c", boardId: "b", state: "running", golden: false, runId: "run_1" }]
    },
    applyCommands: true
  });
  const result = runtime.submitCommand({ type: "run.cancel", runId: "run_1", reason: "operator" });
  assert.equal(result.outcome, "accepted");
  const status = runtime.getStatus();
  assert.equal(status.runs.running.length, 0);
  assert.equal(status.runs.cancelled.length, 1);
  assert.equal(status.runs.cancelled[0].id, "run_1");
  assert.equal(status.runs.cancelled[0].state, "cancelled");
  assert.equal(status.cards[0].state, "cancelled");
  assert.equal(status.cards[0].runId, undefined);
});

test("applyCommands: session.stop cancels every run on the session", () => {
  const runtime = createRuntime({
    status: {
      readiness: { state: "ready", ready: true },
      runs: {
        running: [
          { id: "run_1", state: "running", sessionId: "s_1", cardId: "card_1" },
          { id: "run_2", state: "running", sessionId: "s_1", cardId: "card_2" }
        ]
      },
      cards: [
        { id: "card_1", title: "a", boardId: "b", state: "running", golden: false, runId: "run_1" },
        { id: "card_2", title: "b", boardId: "b", state: "running", golden: false, runId: "run_2" }
      ]
    },
    applyCommands: true
  });
  runtime.submitCommand({ type: "session.stop", sessionId: "s_1", reason: "operator" });
  const status = runtime.getStatus();
  assert.equal(status.runs.running.length, 0);
  assert.equal(status.runs.cancelled.length, 2);
  assert.ok(status.cards.every((card) => card.state === "cancelled"));
});

test("applyCommands: card.rerun queues the card", () => {
  const runtime = createRuntime({
    status: {
      readiness: { state: "ready", ready: true },
      cards: [{ id: "card_1", title: "c", boardId: "b", state: "failed", golden: false }]
    },
    applyCommands: true
  });
  runtime.submitCommand({ type: "card.rerun", cardId: "card_1", reason: "retry" });
  assert.equal(runtime.getStatus().cards[0].state, "queued");
});

test("applyCommands: card.move changes the column", () => {
  const runtime = createRuntime({
    status: {
      readiness: { state: "ready", ready: true },
      cards: [{ id: "card_1", title: "c", boardId: "b", state: "idle", golden: false, columnId: "ready" }]
    },
    applyCommands: true
  });
  runtime.submitCommand({ type: "card.move", cardId: "card_1", targetColumnId: "done", reason: "ship" });
  assert.equal(runtime.getStatus().cards[0].columnId, "done");
});

test("applyCommands: worktree preserve then cleanup flips the flags", () => {
  const runtime = createRuntime({
    status: {
      readiness: { state: "ready", ready: true },
      worktrees: [{ workspaceKey: "ws_1", path: "/w", dirty: true, preserved: false, dirtyPaths: ["a.txt"] }]
    },
    applyCommands: true
  });
  runtime.submitCommand({ type: "worktree.preserve", workspaceKey: "ws_1", reason: "keep" });
  assert.equal(runtime.getWorktrees()[0].preserved, true);

  runtime.submitCommand({ type: "worktree.cleanup", workspaceKey: "ws_1", reason: "done" });
  const worktree = runtime.getWorktrees()[0];
  assert.equal(worktree.dirty, false);
  assert.equal(worktree.preserved, false);
  assert.deepEqual(worktree.dirtyPaths, []);
});

test("applyCommands: capabilities re-derive after the runner state changes", () => {
  const runtime = createRuntime({
    status: {
      readiness: { state: "ready", ready: true, runnerStatus: "ready" },
      runs: { running: [{ id: "run_1", state: "running", sessionId: "s_1", cardId: "card_1" }] },
      cards: [{ id: "card_1", title: "c", boardId: "b", state: "running", golden: false, runId: "run_1" }]
    },
    applyCommands: true
  });
  const before = runtime.getCapabilities().find((c) => c.id === "codex.cancel");
  assert.equal(before.enabled, true);
  runtime.submitCommand({ type: "run.cancel", runId: "run_1", reason: "operator" });
  const after = runtime.getCapabilities().find((c) => c.id === "codex.cancel");
  assert.equal(after.enabled, false);
});

test("applyCommands stays off by default (dry-run does not mutate state)", () => {
  const runtime = createRuntime({
    status: { readiness: { state: "ready", ready: true, dispatchPaused: false } }
  });
  runtime.submitCommand({ type: "dispatch.pause", reason: "x" });
  assert.equal(runtime.getStatus().readiness.dispatchPaused, false);
});

test("applyCommandToStatus is pure and does not mutate its input", () => {
  const status = normalizeStatus({
    readiness: { state: "ready", ready: true, dispatchPaused: false }
  });
  const next = applyCommandToStatus(status, { type: "dispatch.pause", reason: "x" }, "2026-01-01T00:00:00.000Z");
  assert.equal(status.readiness.dispatchPaused, false);
  assert.equal(next.status.readiness.dispatchPaused, true);
  assert.notEqual(next.status, status);
});
