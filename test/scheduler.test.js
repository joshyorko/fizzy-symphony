import test from "node:test";
import assert from "node:assert/strict";

import { createReconciliationScheduler } from "../src/scheduler.js";

test("scheduler drains webhook hints through non-overlapping reconciliation ticks", async () => {
  const calls = [];
  let releaseFirstTick;
  const firstTickGate = new Promise((resolve) => {
    releaseFirstTick = resolve;
  });
  const scheduler = createReconciliationScheduler({
    intervalMs: 1000,
    runTick: async ({ reason, webhookEvents }) => {
      calls.push({ reason, webhookEvents });
      if (calls.length === 1) await firstTickGate;
      return { ok: true };
    },
    snapshot: async () => null
  });

  const first = scheduler.tickNow("manual");
  scheduler.enqueueWebhookHint({ event_id: "event_1", card_id: "card_1" });
  const second = scheduler.tickNow("manual-overlap");

  assert.equal(calls.length, 1);
  assert.equal(scheduler.running, true);

  releaseFirstTick();
  await first;
  await second;

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { reason: "manual", webhookEvents: [] });
  assert.deepEqual(calls[1], {
    reason: "webhook",
    webhookEvents: [{ event_id: "event_1", card_id: "card_1" }]
  });
  assert.equal(scheduler.running, false);
  scheduler.stop();
});

test("scheduler starts immediate ticks, schedules periodic ticks, writes snapshots, and stops timers", async () => {
  const timers = createManualTimers();
  const calls = [];
  const scheduler = createReconciliationScheduler({
    intervalMs: 5000,
    timers,
    runTick: async ({ reason }) => {
      calls.push(`tick:${reason}`);
      return { ok: true };
    },
    snapshot: async () => {
      calls.push("snapshot");
    }
  });

  scheduler.start();
  assert.equal(timers.pending.length, 1);
  await timers.runNext();
  assert.deepEqual(calls, ["tick:startup", "snapshot"]);

  assert.equal(timers.pending.length, 1);
  await timers.runNext();
  assert.deepEqual(calls, ["tick:startup", "snapshot", "tick:interval", "snapshot"]);

  scheduler.stop();
  assert.equal(timers.pending.length, 0);
});

function createManualTimers() {
  const pending = [];
  return {
    pending,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      pending.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
      const index = pending.indexOf(timer);
      if (index !== -1) pending.splice(index, 1);
    },
    async runNext() {
      const timer = pending.shift();
      assert.ok(timer, "expected a pending timer");
      if (!timer.cleared) await timer.callback();
    }
  };
}
