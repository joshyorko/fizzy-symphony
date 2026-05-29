import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createCockpitModel } from "../../src/v2/cockpit/model.ts";
import { normalizeStatus } from "../../src/v2/core/status.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "v2");

function loadFixture(name) {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
  return { status: normalizeStatus(raw.status), events: raw.events ?? [] };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test("cockpit model is pure: frozen input does not throw and is not mutated", () => {
  const { status, events } = loadFixture("running-one-card.json");
  const snapshot = JSON.parse(JSON.stringify(status));
  deepFreeze(status);
  deepFreeze(events);
  const model = createCockpitModel({ status, events, selectedId: "card_426" });
  assert.ok(model.header);
  // input unchanged
  assert.deepEqual(JSON.parse(JSON.stringify(status)), snapshot);
});

test("ready fixture renders factory open with no active runs", () => {
  const { status, events } = loadFixture("ready.json");
  const model = createCockpitModel({ status, events });
  assert.equal(model.factoryState, "open");
  assert.equal(model.header.counts.running, 0);
  assert.equal(model.panels.activeRuns.length, 0);
});

test("running fixture surfaces a machine in motion", () => {
  const { status, events } = loadFixture("running-one-card.json");
  const model = createCockpitModel({ status, events });
  assert.equal(model.factoryState, "running");
  assert.equal(model.header.counts.running, 1);
  const run = model.panels.activeRuns.find((r) => r.id === "run_426");
  assert.equal(run.themeLabel, "Machine in motion");
});

test("blocked-runner fixture surfaces blocked factory and disabled route", () => {
  const { status } = loadFixture("blocked-runner.json");
  const model = createCockpitModel({ status });
  assert.equal(model.factoryState, "blocked");
  const lane = model.lanes.find((l) => l.routeId === "route_ready");
  assert.equal(lane.enabled, false);
  assert.equal(lane.disabledReason, "Runner unavailable");
});

test("locked factory when dispatch paused", () => {
  const { status } = loadFixture("commands-disabled.json");
  const model = createCockpitModel({ status });
  assert.equal(model.factoryState, "locked");
});

test("dirty worktree is surfaced as a hazard with raw truth", () => {
  const { status } = loadFixture("dirty-worktree.json");
  const model = createCockpitModel({ status, selectedId: "ws_426" });
  const wt = model.panels.worktrees.find((w) => w.workspaceKey === "ws_426");
  assert.equal(wt.dirty, true);
  assert.equal(wt.themeLabel, "Spill / hazard");
  assert.equal(model.selected.kind, "worktree");
  assert.equal(model.selected.raw.workspacePath, "/work/repo/.fizzy-symphony/worktrees/card-426");
  assert.deepEqual(model.selected.raw.dirtyPaths, ["src/terminal-renderer.js", ".fizzy-symphony/notes.md"]);
});

test("failed run is surfaced with error in active runs panel", () => {
  const { status } = loadFixture("failed-run.json");
  const model = createCockpitModel({ status });
  const failed = model.panels.activeRuns.find((r) => r.state === "failed");
  assert.ok(failed);
  assert.equal(failed.error.code, "RUNNER_ERROR");
});

test("selecting a card exposes raw ids in the detail panel", () => {
  const { status } = loadFixture("running-one-card.json");
  const model = createCockpitModel({ status, selectedId: "card_426" });
  assert.equal(model.selected.kind, "card");
  assert.equal(model.selected.raw.cardId, "card_426");
  assert.equal(model.selected.raw.runId, "run_426");
  assert.equal(model.selected.raw.sessionId, "session_9");
  assert.equal(model.selected.raw.boardId, "board_42");
});

test("actions reflect enabled/disabled with reasons", () => {
  const { status } = loadFixture("ready.json");
  const model = createCockpitModel({ status });
  const cancel = model.actions.find((a) => a.id === "run.cancel");
  assert.equal(cancel.enabled, false);
  assert.equal(cancel.disabledReason, "No run selected");

  const running = loadFixture("running-one-card.json");
  const runModel = createCockpitModel({ status: running.status, selectedId: "run_426" });
  const cancelEnabled = runModel.actions.find((a) => a.id === "run.cancel");
  assert.equal(cancelEnabled.enabled, true);
  assert.equal(cancelEnabled.commandType, "run.cancel");
});

test("filter narrows lane cards without mutating status", () => {
  const { status } = loadFixture("running-multiple-cards.json");
  const before = status.cards.length;
  const model = createCockpitModel({ status, filter: "cockpit help" });
  const allCards = model.lanes.flatMap((l) => l.cards);
  assert.ok(allCards.every((c) => c.title.toLowerCase().includes("cockpit help") || c.id.includes("cockpit")));
  assert.equal(status.cards.length, before);
});

test("help is generated from capabilities, not hardcoded", () => {
  const { status } = loadFixture("ready.json");
  const model = createCockpitModel({ status });
  assert.ok(model.help.capabilities.length > 0);
  assert.ok(model.help.keys.some((k) => k.key === "?"));
});
