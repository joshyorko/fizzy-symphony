import test from "node:test";
import assert from "node:assert/strict";

import { createFakeFizzyPort } from "../../src/v2/fizzy/fake.ts";
import { createFizzyAdapter } from "../../src/v2/fizzy/adapter.ts";
import { createFakeCodexRunner } from "../../src/v2/codex/fake.ts";
import { createCodexAdapter } from "../../src/v2/codex/adapter.ts";

test("fake FizzyPort serves seeded boards and cards", async () => {
  const port = createFakeFizzyPort({
    boards: [{ id: "b1", name: "Agents" }],
    cards: [{ id: "c1", number: 1, title: "Golden", boardId: "b1", columnId: "ready", golden: true }]
  });
  assert.equal(port.describe().sdk, false);
  assert.equal((await port.listBoards()).length, 1);
  assert.equal((await port.listCards({ boardId: "b1" })).length, 1);
  const comment = await port.createComment({ cardId: "c1", body: "claim" });
  assert.equal(comment.cardId, "c1");
  const moved = await port.moveCard({ cardId: "c1", targetColumnId: "done" });
  assert.equal(moved.columnId, "done");
});

test("Fizzy adapter advertises its boundary and requires a configured live client", async () => {
  const sdk = createFizzyAdapter({ mode: "sdk" });
  assert.equal(sdk.describe().sdk, true);
  await assert.rejects(() => sdk.listBoards(), /account slug|credentials|access/i);

  const http = createFizzyAdapter({ mode: "http" });
  assert.equal(http.describe().sdk, false);
});

test("Fizzy adapter delegates to a real client behind the v2 port", async () => {
  const calls = [];
  const client = {
    async listBoards(account) {
      calls.push(["listBoards", account]);
      return [{ id: "board_1", name: "Agents", columns: [{ id: "col_ready", name: "Ready" }] }];
    },
    async getBoard(boardId) {
      calls.push(["getBoard", boardId]);
      return { id: boardId, name: "Agents", columns: [{ id: "col_ready", name: "Ready" }] };
    },
    async listCards(input) {
      calls.push(["listCards", input]);
      return [{ id: "card_uuid", number: 42, title: "Do work", board_id: "board_1", column_id: "col_ready", tags: ["agent"], golden: true }];
    },
    async getCard(input) {
      calls.push(["getCard", input]);
      return { id: "card_uuid", number: input.cardNumber, title: "Do work", board_id: "board_1", column_id: "col_ready" };
    },
    async listComments(input) {
      calls.push(["listComments", input]);
      return [{ id: "comment_1", body: { plain_text: "hello" }, created_at: "2026-05-31T12:00:00.000Z" }];
    },
    async createComment(input) {
      calls.push(["createComment", input]);
      return { id: "comment_2", body: input.body };
    },
    async updateComment(input) {
      calls.push(["updateComment", input]);
      return { id: input.commentId, body: input.body };
    },
    async moveCardToColumn(input) {
      calls.push(["moveCardToColumn", input]);
      return { id: "card_uuid", number: input.cardNumber, title: "Do work", board_id: "board_1", column_id: input.column_id };
    }
  };
  const port = createFizzyAdapter({ mode: "sdk", client, account: "acct" });

  assert.deepEqual(await port.listBoards(), [{ id: "board_1", name: "Agents", columns: [{ id: "col_ready", name: "Ready" }] }]);
  assert.deepEqual(await port.listCards({ boardId: "board_1", columnId: "col_ready" }), [
    { id: "card_uuid", number: 42, title: "Do work", boardId: "board_1", columnId: "col_ready", tags: ["agent"], golden: true }
  ]);
  assert.equal((await port.getCard({ cardId: "42" })).id, "card_uuid");
  assert.deepEqual(await port.listComments({ cardId: "42" }), [
    { id: "comment_1", cardId: "42", body: "hello", createdAt: "2026-05-31T12:00:00.000Z" }
  ]);
  assert.equal((await port.createComment({ cardId: "42", body: "<p>rerun</p>" })).cardId, "42");
  assert.equal((await port.updateComment({ commentId: "comment_2", cardId: "42", body: "<p>updated</p>" })).body, "<p>updated</p>");
  assert.equal((await port.moveCard({ cardId: "card_uuid", cardNumber: 42, targetColumnId: "col_done" })).columnId, "col_done");
  assert.deepEqual(calls.map((call) => call[0]), [
    "listBoards",
    "listCards",
    "getCard",
    "listComments",
    "createComment",
    "updateComment",
    "moveCardToColumn"
  ]);
});

test("fake Codex runner streams a completed turn", async () => {
  const runner = createFakeCodexRunner();
  assert.equal((await runner.detect()).available, true);
  assert.equal((await runner.health()).status, "ready");
  const session = await runner.startSession({ workspacePath: "/ws" });
  const turn = await runner.startTurn({ session, prompt: "do" });
  const events = [];
  const result = await runner.streamTurn({ turn }, (e) => events.push(e));
  assert.equal(result.status, "completed");
  assert.ok(events.some((e) => e.type === "turn.completed"));
});

test("fake Codex runner can simulate failure and cancellation", async () => {
  const failing = createFakeCodexRunner({ mode: "failed" });
  const session = await failing.startSession({ workspacePath: "/ws" });
  const turn = await failing.startTurn({ session, prompt: "do" });
  const result = await failing.streamTurn({ turn }, () => {});
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "RUNNER_ERROR");

  const cancel = await failing.cancelTurn({ turn, reason: "operator" });
  assert.equal(cancel.status, "cancelled");
});

test("Codex adapter is SDK-backed and reports package health", async () => {
  const sdk = createCodexAdapter({ mode: "sdk" });
  assert.equal(sdk.describe().sdk, true);
  assert.equal(sdk.describe().contract, "codex-runner-sdk-v1");
  assert.equal((await sdk.detect()).available, true);
  const health = await sdk.health();
  assert.equal(health.status, "ready");
});

test("Codex SDK-mode adapter delegates to the real SDK shape behind the v2 port", async () => {
  const calls = [];
  class FakeCodexSdk {
    constructor(options) {
      calls.push(["sdk.constructor", options.codexPathOverride]);
    }
    startThread(options) {
      calls.push(["sdk.startThread", options.workingDirectory, options.model, options.approvalPolicy]);
      return new FakeThread();
    }
  }
  class FakeThread {
    id = null;
    async runStreamed(input, options) {
      calls.push(["sdk.runStreamed", input, Boolean(options.signal)]);
      return {
        events: (async function* events() {
          yield { type: "thread.started", thread_id: "sdk_thread_1" };
          yield { type: "turn.started" };
          yield { type: "item.completed", item: { id: "msg_1", type: "agent_message", text: "ok" } };
          yield { type: "turn.completed", usage: null };
        })()
      };
    }
  }
  const adapter = createCodexAdapter({
    mode: "sdk",
    sdkFactory: (options) => new FakeCodexSdk(options),
    command: "/usr/local/bin/codex",
    config: {
      agent: { default_model: "gpt-5.5", reasoning_effort: "medium" },
      runner: {
        preferred: "sdk",
        codex: {
          thread_sandbox: "workspace-write",
          approval_policy: { mode: "reject" }
        }
      }
    }
  });

  assert.equal(adapter.describe().sdk, true);
  assert.equal((await adapter.detect()).available, true);
  assert.equal((await adapter.health()).status, "ready");
  const session = await adapter.startSession({ workspacePath: "/tmp/sdk-workspace", metadata: { cardId: "card_1" } });
  const turn = await adapter.startTurn({ session, prompt: "do sdk work" });
  const events = [];
  assert.equal((await adapter.streamTurn({ turn }, (event) => events.push(event))).status, "completed");
  assert.deepEqual(events.map((event) => event.type), [
    "thread.started",
    "turn.started",
    "item.completed",
    "turn.completed"
  ]);
  assert.equal((await adapter.cancelTurn({ turn, reason: "operator" })).status, "cancelled");
  await adapter.stopSession({ session, reason: "operator" });
  assert.deepEqual(calls.map((call) => call[0]), [
    "sdk.constructor",
    "sdk.startThread",
    "sdk.runStreamed"
  ]);
});

test("Codex cli-app-server adapter delegates to a real runner behind the v2 port", async () => {
  const calls = [];
  const delegate = {
    async detect(config) {
      calls.push(["detect", config.runner.preferred]);
      return { kind: "cli_app_server", available: true, version: "codex 0.125.0" };
    },
    async health(config) {
      calls.push(["health", config.runner.preferred]);
      return { status: "ready", kind: "cli_app_server", checked_at: "2026-05-31T12:00:00.000Z" };
    },
    async startSession(workspacePath, policies, metadata) {
      calls.push(["startSession", workspacePath, policies.route.model, metadata.cardId]);
      return { session_id: "thread_1", thread_id: "thread_1", workspace_path: workspacePath, process_owned: true };
    },
    async startTurn(session, prompt, metadata) {
      calls.push(["startTurn", session.session_id, prompt, metadata.runId]);
      return { turn_id: "turn_1", session_id: session.session_id, thread_id: session.thread_id };
    },
    async stream(turn, onEvent) {
      calls.push(["stream", turn.turn_id]);
      onEvent?.({ type: "assistant.delta", text: "ok" });
      return { status: "completed", turn_id: turn.turn_id, session_id: turn.session_id };
    },
    async cancel(turn, reason) {
      calls.push(["cancel", turn.turn_id, reason]);
      return { status: "cancelled", turn_id: turn.turn_id, session_id: turn.session_id };
    },
    async stopSession(session) {
      calls.push(["stopSession", session.session_id]);
      return { status: "stopped", success: true };
    },
    async terminateOwnedProcess(session) {
      calls.push(["terminateOwnedProcess", session.session_id]);
      return { status: "terminated", success: true };
    }
  };
  const adapter = createCodexAdapter({
    mode: "cli-app-server",
    runner: delegate,
    config: {
      runner: { preferred: "cli_app_server" },
      agent: { default_model: "gpt-5.5", reasoning_effort: "medium" }
    }
  });

  assert.equal((await adapter.detect()).available, true);
  assert.equal((await adapter.health()).status, "ready");
  const session = await adapter.startSession({
    workspacePath: "/tmp/workspace",
    model: "gpt-5.5",
    metadata: { cardId: "card_1" }
  });
  assert.deepEqual(session, { sessionId: "thread_1", workspacePath: "/tmp/workspace" });
  const turn = await adapter.startTurn({ session, prompt: "do it", metadata: { runId: "run_1" } });
  assert.deepEqual(turn, { turnId: "turn_1", sessionId: "thread_1" });
  const events = [];
  assert.equal((await adapter.streamTurn({ turn }, (event) => events.push(event))).status, "completed");
  assert.equal(events[0].text, "ok");
  assert.equal((await adapter.cancelTurn({ turn, reason: "operator" })).status, "cancelled");
  await adapter.stopSession({ session, reason: "operator" });
  assert.deepEqual(calls.map((call) => call[0]), [
    "detect",
    "health",
    "startSession",
    "startTurn",
    "stream",
    "cancel",
    "stopSession"
  ]);

  const terminateSession = await adapter.startSession({ workspacePath: "/tmp/terminate" });
  await adapter.terminateOwnedProcess({ sessionId: terminateSession.sessionId, reason: "operator" });
  assert.equal(calls.at(-1)[0], "terminateOwnedProcess");
});

test("Codex cli-app-server adapter skips process termination after a clean stop", async () => {
  const calls = [];
  const delegate = {
    async startSession(workspacePath) {
      calls.push(["startSession", workspacePath]);
      return { session_id: "thread_1", thread_id: "thread_1", workspace_path: workspacePath, process_owned: true };
    },
    async stopSession(session) {
      calls.push(["stopSession", session.session_id]);
      return { status: "stopped", success: true };
    },
    async terminateOwnedProcess(session) {
      calls.push(["terminateOwnedProcess", session.session_id]);
      throw new Error("stopSession already closed the app-server process");
    }
  };
  const adapter = createCodexAdapter({ mode: "cli-app-server", runner: delegate });
  const session = await adapter.startSession({ workspacePath: "/tmp/workspace" });

  await adapter.stopSession({ session, reason: "operator" });
  await adapter.terminateOwnedProcess({ sessionId: session.sessionId, reason: "operator" });

  assert.deepEqual(calls.map((call) => call[0]), ["startSession", "stopSession"]);
});
