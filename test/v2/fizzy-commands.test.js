import test from "node:test";
import assert from "node:assert/strict";

import { createRuntime } from "../../src/v2/daemon/runtime.ts";
import { dispatchPortEffects } from "../../src/v2/daemon/port-effects.ts";
import { normalizeStatus } from "../../src/v2/core/status.ts";
import { createFakeFizzyPort } from "../../src/v2/fizzy/fake.ts";

function boardStatus() {
  return {
    readiness: { state: "ready", ready: true },
    cards: [{ id: "card_1", title: "c", boardId: "board_1", columnId: "col_a", state: "running", golden: false }]
  };
}

// Records every FizzyPort call so tests can assert the board was driven.
function spyFizzy(overrides = {}) {
  const calls = [];
  const base = createFakeFizzyPort({
    boards: [{ id: "board_1", name: "Board" }],
    cards: [{ id: "card_1", title: "c", boardId: "board_1", columnId: "col_a" }]
  });
  return {
    calls,
    port: {
      ...base,
      async moveCard(input) {
        calls.push(["moveCard", input]);
        if (overrides.moveCard) return overrides.moveCard(input);
        return base.moveCard(input);
      },
      async createComment(input) {
        calls.push(["createComment", input]);
        if (overrides.createComment) return overrides.createComment(input);
        return base.createComment(input);
      }
    }
  };
}

test("submitCommandAsync drives Fizzy moveCard on card.move", async () => {
  const fizzy = spyFizzy();
  const runtime = createRuntime({ status: boardStatus(), fizzy: fizzy.port, applyCommands: true });
  const result = await runtime.submitCommandAsync({
    type: "card.move",
    cardId: "card_1",
    targetColumnId: "col_b",
    reason: "operator"
  });
  assert.equal(result.outcome, "accepted");

  const move = fizzy.calls.find((c) => c[0] === "moveCard");
  assert.ok(move, "moveCard should have been called");
  assert.equal(move[1].cardId, "card_1");
  assert.equal(move[1].targetColumnId, "col_b");

  const effect = runtime.getEvents(20).find((e) => e.type === "command.effect.card.move");
  assert.ok(effect);
  assert.equal(effect.boardId, "board_1");
});

test("submitCommandAsync records a rerun note on card.rerun", async () => {
  const fizzy = spyFizzy();
  const status = {
    readiness: { state: "ready", ready: true },
    cards: [{ id: "card_1", title: "c", boardId: "board_1", columnId: "col_a", state: "failed", golden: false }]
  };
  const runtime = createRuntime({ status, fizzy: fizzy.port, applyCommands: true });
  await runtime.submitCommandAsync({ type: "card.rerun", cardId: "card_1", reason: "flaky" });

  const comment = fizzy.calls.find((c) => c[0] === "createComment");
  assert.ok(comment, "createComment should have been called");
  assert.match(comment[1].body, /Rerun requested by operator: flaky/);
  assert.ok(runtime.getEvents(20).some((e) => e.type === "command.effect.card.rerun"));
});

test("submitCommandAsync records a Fizzy failure as an error effect event", async () => {
  const fizzy = spyFizzy({
    moveCard() {
      throw new Error("board offline");
    }
  });
  const runtime = createRuntime({ status: boardStatus(), fizzy: fizzy.port, applyCommands: true });
  const result = await runtime.submitCommandAsync({
    type: "card.move",
    cardId: "card_1",
    targetColumnId: "col_b",
    reason: "x"
  });
  assert.equal(result.outcome, "accepted");
  const failure = runtime.getEvents(20).find((e) => e.type === "command.effect.card.move");
  assert.equal(failure.severity, "error");
  assert.equal(failure.data.code, "FIZZY_MOVE_FAILED");
});

test("submitCommandAsync without a Fizzy port is model-only (no effect events)", async () => {
  const runtime = createRuntime({ status: boardStatus(), applyCommands: true });
  await runtime.submitCommandAsync({ type: "card.move", cardId: "card_1", targetColumnId: "col_b", reason: "x" });
  assert.ok(!runtime.getEvents(20).some((e) => e.type.startsWith("command.effect.")));
});

test("dispatchPortEffects returns no effects for card.move without a Fizzy port", async () => {
  const status = normalizeStatus(boardStatus());
  const effects = await dispatchPortEffects(
    { type: "card.move", cardId: "card_1", targetColumnId: "col_b", reason: "x" },
    status,
    {}
  );
  assert.deepEqual(effects, []);
});
