import test from "node:test";
import assert from "node:assert/strict";

import { createFakeCodexRunner } from "../src/runner-contract.js";

test("fake Codex runner contract supports detect, validate, init, harmless streaming turn, and cancel", async () => {
  const runner = createFakeCodexRunner({
    events: [
      { type: "turn.started", turn_id: "turn_1" },
      { type: "assistant.delta", text: "ok" },
      { type: "turn.completed", turn_id: "turn_1" }
    ]
  });

  assert.deepEqual(await runner.detect(), {
    kind: "cli_app_server",
    available: true,
    contract: "codex-runner-fake-v1"
  });

  assert.deepEqual(await runner.validate({ preferred: "cli_app_server" }), {
    ok: true,
    kind: "cli_app_server",
    contract: "codex-runner-fake-v1"
  });

  const session = await runner.startSession({ workspace: "/tmp/workspace", metadata: { card_id: "card_1" } });
  assert.equal(session.session_id, "session_1");

  const init = await runner.initSession(session);
  assert.deepEqual(init, { ok: true, session_id: "session_1" });

  const streamed = [];
  const result = await runner.runTurn(session, {
    input: "harmless noop",
    onEvent: (event) => streamed.push(event)
  });

  assert.equal(result.type, "TurnResult");
  assert.equal(result.status, "completed");
  assert.equal(result.session_id, "session_1");
  assert.deepEqual(streamed.map((event) => event.type), ["turn.started", "assistant.delta", "turn.completed"]);

  assert.deepEqual(await runner.cancel(session, { reason: "operator" }), {
    type: "TurnResult",
    status: "cancelled",
    session_id: "session_1",
    cancellation: { reason: "operator" }
  });
});

test("fake Codex runner reports input-required and runner errors through shaped turn results", async () => {
  const inputRequired = createFakeCodexRunner({ mode: "input_required" });
  const inputResult = await inputRequired.runTurn({ session_id: "session_1" }, { input: "needs approval" });

  assert.deepEqual(inputResult, {
    type: "TurnResult",
    status: "failed",
    failure_kind: "input_required",
    error: {
      type: "RunnerError",
      code: "RUNNER_INPUT_REQUIRED",
      message: "Runner requested operator input in unattended mode."
    }
  });

  const failed = createFakeCodexRunner({ mode: "error", errorCode: "APP_SERVER_EXITED" });
  const errorResult = await failed.runTurn({ session_id: "session_2" }, { input: "boom" });

  assert.equal(errorResult.type, "TurnResult");
  assert.equal(errorResult.status, "failed");
  assert.equal(errorResult.failure_kind, "runner_error");
  assert.deepEqual(errorResult.error, {
    type: "RunnerError",
    code: "APP_SERVER_EXITED",
    message: "Fake runner error."
  });
});
