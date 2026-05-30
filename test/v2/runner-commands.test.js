import test from "node:test";
import assert from "node:assert/strict";

import { createRuntime } from "../../src/v2/daemon/runtime.ts";
import { dispatchPortEffects } from "../../src/v2/daemon/port-effects.ts";
import { normalizeStatus } from "../../src/v2/core/status.ts";
import { createFakeCodexRunner } from "../../src/v2/codex/fake.ts";

function runningStatus() {
  return {
    readiness: { state: "ready", ready: true, runnerStatus: "ready" },
    runs: {
      running: [
        { id: "run_1", state: "running", sessionId: "s_1", turnId: "turn_1", workspacePath: "/ws", cardId: "card_1" }
      ]
    },
    cards: [{ id: "card_1", title: "c", boardId: "b", state: "running", golden: false, runId: "run_1" }]
  };
}

// Records every CodexRunnerPort call so tests can assert the runner was driven.
function spyRunner(overrides = {}) {
  const calls = [];
  const base = createFakeCodexRunner();
  return {
    calls,
    port: {
      ...base,
      async cancelTurn(input) {
        calls.push(["cancelTurn", input]);
        if (overrides.cancelTurn) return overrides.cancelTurn(input);
        return base.cancelTurn(input);
      },
      async stopSession(input) {
        calls.push(["stopSession", input]);
        if (overrides.stopSession) return overrides.stopSession(input);
        return base.stopSession(input);
      },
      async terminateOwnedProcess(input) {
        calls.push(["terminateOwnedProcess", input]);
      }
    }
  };
}

test("submitCommandAsync drives the runner cancelTurn on run.cancel", async () => {
  const runner = spyRunner();
  const runtime = createRuntime({ status: runningStatus(), codex: runner.port, applyCommands: true });
  const result = await runtime.submitCommandAsync({ type: "run.cancel", runId: "run_1", reason: "operator" });
  assert.equal(result.outcome, "accepted");

  const cancel = runner.calls.find((c) => c[0] === "cancelTurn");
  assert.ok(cancel, "cancelTurn should have been called");
  assert.equal(cancel[1].turn.turnId, "turn_1");
  assert.equal(cancel[1].reason, "operator");

  const status = runtime.getStatus();
  assert.equal(status.runs.running.length, 0);
  assert.ok(runtime.getEvents(20).some((e) => e.type === "command.effect.run.cancel"));
});

test("submitCommandAsync drives stopSession + terminateOwnedProcess on session.stop", async () => {
  const runner = spyRunner();
  const status = {
    readiness: { state: "ready", ready: true },
    runs: {
      running: [
        { id: "run_1", state: "running", sessionId: "s_1", turnId: "t_1", workspacePath: "/ws", cardId: "card_1" },
        { id: "run_2", state: "running", sessionId: "s_1", turnId: "t_2", workspacePath: "/ws", cardId: "card_2" }
      ]
    },
    cards: [
      { id: "card_1", title: "a", boardId: "b", state: "running", golden: false, runId: "run_1" },
      { id: "card_2", title: "b", boardId: "b", state: "running", golden: false, runId: "run_2" }
    ]
  };
  const runtime = createRuntime({ status, codex: runner.port, applyCommands: true });
  await runtime.submitCommandAsync({ type: "session.stop", sessionId: "s_1", reason: "operator" });

  assert.ok(runner.calls.some((c) => c[0] === "stopSession"));
  assert.ok(runner.calls.some((c) => c[0] === "terminateOwnedProcess"));
  assert.equal(runtime.getStatus().runs.running.length, 0);
});

test("submitCommandAsync records a runner failure as an error effect event", async () => {
  const runner = spyRunner({
    cancelTurn() {
      throw new Error("runner offline");
    }
  });
  const runtime = createRuntime({ status: runningStatus(), codex: runner.port, applyCommands: true });
  const result = await runtime.submitCommandAsync({ type: "run.cancel", runId: "run_1", reason: "x" });
  // The model change still applies; the failure is surfaced as an audit event.
  assert.equal(result.outcome, "accepted");
  const failure = runtime.getEvents(20).find((e) => e.type === "command.effect.run.cancel");
  assert.equal(failure.severity, "error");
  assert.equal(failure.data.code, "RUNNER_CANCEL_FAILED");
});

test("submitCommandAsync without a runner is model-only (no effect events)", async () => {
  const runtime = createRuntime({ status: runningStatus(), applyCommands: true });
  await runtime.submitCommandAsync({ type: "run.cancel", runId: "run_1", reason: "x" });
  assert.ok(!runtime.getEvents(20).some((e) => e.type.startsWith("command.effect.")));
});

test("submitCommandAsync stays dry-run when applyCommands is off and skips the runner", async () => {
  const runner = spyRunner();
  const runtime = createRuntime({ status: runningStatus(), codex: runner.port });
  const result = await runtime.submitCommandAsync({ type: "run.cancel", runId: "run_1", reason: "x" });
  assert.equal(result.outcome, "dry-run");
  assert.equal(runner.calls.length, 0);
  assert.equal(runtime.getStatus().runs.running.length, 1);
});

test("dispatchPortEffects warns when a run has no active turn", async () => {
  const runner = spyRunner();
  const status = normalizeStatus({
    runs: { running: [{ id: "run_1", state: "running", sessionId: "s_1", cardId: "card_1" }] }
  });
  const effects = await dispatchPortEffects(
    { type: "run.cancel", runId: "run_1", reason: "x" },
    status,
    { codex: runner.port }
  );
  assert.equal(effects.length, 1);
  assert.equal(effects[0].severity, "warning");
  assert.equal(runner.calls.length, 0);
});
