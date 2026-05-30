import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { startInteractiveCockpit } from "../../src/v2/cockpit/interactive.ts";
import { createRuntime } from "../../src/v2/daemon/runtime.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "v2");

function loadRuntime(name) {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
  return createRuntime({ status: raw.status, events: raw.events ?? [] });
}

function fakeTerminal() {
  const frames = [];
  const term = (text) => frames.push(text);
  term.frames = frames;
  term.fullscreen = () => {};
  term.clear = () => {};
  term.moveTo = () => {};
  term.hideCursor = () => {};
  term.grabInput = () => {};
  term.on = () => {};
  term.off = () => {};
  return term;
}

test("interactive cockpit submits a typed command via keypress (dry-run)", async () => {
  const runtime = loadRuntime("running-one-card.json");
  const term = fakeTerminal();
  const session = await startInteractiveCockpit({ runtime, terminalFactory: async () => term });

  // selectable order: card_golden, card_426, run_426, ws_426. Move to card_426.
  session.handleKey("DOWN");
  const model = session.currentModel();
  assert.equal(model.selected.raw.runId, "run_426");

  session.handleKey("c"); // run.cancel
  const lastFrame = term.frames.at(-1);
  assert.match(lastFrame, /DRY-RUN/);

  const events = runtime.getEvents(10);
  assert.ok(events.some((e) => e.type === "command.dry-run.run.cancel"));

  session.handleKey("q");
  await session.done;
});

test("interactive cockpit shows a disabled reason when action unavailable", async () => {
  const runtime = loadRuntime("ready.json");
  const term = fakeTerminal();
  const session = await startInteractiveCockpit({ runtime, terminalFactory: async () => term });
  session.handleKey("c"); // no run selected
  assert.match(term.frames.at(-1), /disabled/i);
  session.handleKey("q");
  await session.done;
});

test("interactive cockpit quits on ESCAPE", async () => {
  const runtime = loadRuntime("ready.json");
  const term = fakeTerminal();
  const session = await startInteractiveCockpit({ runtime, terminalFactory: async () => term });
  session.handleKey("ESCAPE");
  await session.done; // resolves
  assert.ok(true);
});
