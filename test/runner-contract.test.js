import test from "node:test";
import assert from "node:assert/strict";

import { createFakeCodexRunner } from "../src/runner-contract.js";

test("fake Codex runner contract supports SPEC method names for harmless streaming turn, cancel, and stop", async () => {
  const runner = createFakeCodexRunner({
    events: [
      { type: "turn.started", turn_id: "turn_1" },
      { type: "assistant.delta", text: "ok" },
      { type: "turn.completed", turn_id: "turn_1" }
    ]
  });
  const config = { runner: { preferred: "cli_app_server" } };
  const workspace = { path: "/tmp/workspace" };
  const policies = { sandbox: "workspace-write" };
  const metadata = { card_id: "card_1" };

  assert.deepEqual(await runner.detect(config), {
    kind: "cli_app_server",
    available: true,
    contract: "codex-runner-fake-v1"
  });

  assert.deepEqual(await runner.validate(config, workspace), {
    ok: true,
    kind: "cli_app_server",
    contract: "codex-runner-fake-v1",
    workspace
  });

  assert.deepEqual(await runner.health(config), {
    status: "ready",
    kind: "cli_app_server",
    contract: "codex-runner-fake-v1"
  });

  const session = await runner.startSession(workspace, policies, metadata);
  assert.equal(session.session_id, "session_1");
  assert.deepEqual(session.workspace, workspace);

  const turn = await runner.startTurn(session, "harmless noop", metadata);
  assert.equal(turn.turn_id, "turn_1");
  assert.equal(turn.prompt, "harmless noop");

  const streamed = [];
  const result = await runner.stream(turn, (event) => streamed.push(event));

  assert.equal(result.type, "TurnResult");
  assert.equal(result.status, "completed");
  assert.equal(result.session_id, "session_1");
  assert.equal(result.turn_id, "turn_1");
  assert.deepEqual(streamed.map((event) => event.type), ["turn.started", "assistant.delta", "turn.completed"]);

  assert.deepEqual(await runner.cancel(turn, "operator"), {
    type: "CancelResult",
    status: "cancelled",
    session_id: "session_1",
    turn_id: "turn_1",
    reason: "operator"
  });

  assert.deepEqual(await runner.stopSession(session), {
    type: "StopSessionResult",
    status: "stopped",
    session_id: "session_1"
  });
});

test("fake Codex runner reports input-required and runner errors through shaped turn results", async () => {
  const inputRequired = createFakeCodexRunner({ mode: "input_required" });
  const inputTurn = await inputRequired.startTurn({ session_id: "session_1" }, "needs approval", {});
  const inputResult = await inputRequired.stream(inputTurn, () => {});

  assert.deepEqual(inputResult, {
    type: "TurnResult",
    status: "failed",
    session_id: "session_1",
    turn_id: "turn_1",
    failure_kind: "input_required",
    error: {
      type: "RunnerError",
      code: "RUNNER_INPUT_REQUIRED",
      message: "Runner requested operator input in unattended mode."
    }
  });

  const failed = createFakeCodexRunner({ mode: "error", errorCode: "APP_SERVER_EXITED" });
  const errorTurn = await failed.startTurn({ session_id: "session_2" }, "boom", {});
  const errorResult = await failed.stream(errorTurn, () => {});

  assert.equal(errorResult.type, "TurnResult");
  assert.equal(errorResult.status, "failed");
  assert.equal(errorResult.session_id, "session_2");
  assert.equal(errorResult.turn_id, "turn_1");
  assert.equal(errorResult.failure_kind, "runner_error");
  assert.deepEqual(errorResult.error, {
    type: "RunnerError",
    code: "APP_SERVER_EXITED",
    message: "Fake runner error."
  });
});
