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

test("Fizzy adapter advertises its boundary and refuses to silently fake ops", async () => {
  const sdk = createFizzyAdapter({ mode: "sdk" });
  assert.equal(sdk.describe().sdk, true);
  await assert.rejects(() => sdk.listBoards(), /not wired/);

  const http = createFizzyAdapter({ mode: "http" });
  assert.equal(http.describe().sdk, false);
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

test("Codex adapter is SDK-shaped and reports not-wired health", async () => {
  const sdk = createCodexAdapter({ mode: "sdk" });
  assert.equal(sdk.describe().sdk, true);
  assert.equal(sdk.describe().contract, "codex-runner-sdk-v1");
  const health = await sdk.health();
  assert.equal(health.failureCode, "ADAPTER_NOT_WIRED");
  await assert.rejects(() => sdk.startSession({ workspacePath: "/ws" }), /not wired/);
});
