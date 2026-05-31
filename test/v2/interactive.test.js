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
  const session = await startInteractiveCockpit({
    runtime,
    app: {
      mode: "LIVE",
      source: "http://127.0.0.1:4510/status",
      configPath: "/tmp/fizzy-symphony/config.yml",
      endpoint: "http://127.0.0.1:4510"
    },
    terminalFactory: async () => term
  });
  assert.equal(session.currentModel().selectedSectionId, "factory");
  assert.equal(session.currentModel().app.mode, "LIVE");
  assert.equal(session.currentModel().app.endpoint, "http://127.0.0.1:4510");

  // selectable order: card_golden, card_426, run_426, ws_426. Move to card_426.
  session.handleKey("DOWN");
  const model = session.currentModel();
  assert.equal(model.selected.raw.runId, "run_426");

  session.handleKey("c"); // run.cancel
  const lastFrame = term.frames.at(-1);
  assert.match(lastFrame, /DRY-RUN/);

  session.handleKey("2");
  assert.equal(session.currentModel().selectedSectionId, "runs");

  session.handleKey("3");
  assert.equal(session.currentModel().selectedSectionId, "worktrees");

  session.handleKey("a");
  assert.equal(session.currentModel().selectedSectionId, "worktrees");
  assert.match(term.frames.at(-1), /Actions/);

  session.handleKey("8");
  assert.equal(session.currentModel().selectedSectionId, "advanced");

  session.handleKey("CTRL_P");
  assert.equal(session.currentModel().commandPaletteOpen, true);
  session.handleKey("CTRL_P");
  assert.equal(session.currentModel().commandPaletteOpen, false);

  const events = runtime.getEvents(10);
  assert.ok(events.some((e) => e.type === "command.dry-run.run.cancel"));

  session.handleKey("q");
  await session.done;
});

test("interactive command palette dispatches sections, actions, and command hints", async () => {
  const runtime = loadRuntime("running-one-card.json");
  const term = fakeTerminal();
  const session = await startInteractiveCockpit({
    runtime,
    app: { mode: "OFFLINE", source: "config", configPath: "/tmp/fizzy-symphony/config.yml" },
    terminalFactory: async () => term
  });

  session.handleKey("DOWN"); // card_426 has run/session ids for action commands.

  session.handleKey("CTRL_P");
  session.handleKey("2");
  assert.equal(session.currentModel().selectedSectionId, "runs");
  assert.equal(session.currentModel().commandPaletteOpen, false);

  session.handleKey("CTRL_P");
  session.handleKey("A");
  session.handleKey("c");
  assert.equal(session.currentModel().commandPaletteOpen, false);
  assert.match(term.frames.at(-1), /DRY-RUN/);
  assert.ok(runtime.getEvents(10).some((event) => event.type === "command.dry-run.run.cancel"));

  session.handleKey("CTRL_P");
  session.handleKey("V");
  session.handleKey("q");
  assert.equal(session.currentModel().commandPaletteOpen, false);
  assert.match(term.frames.at(-1), /dashboard disabled: No live endpoint connected\./);

  session.handleKey("CTRL_P");
  session.handleKey("V:D");
  assert.equal(session.currentModel().commandPaletteOpen, false);
  assert.match(term.frames.at(-1), /doctor: fizzy-symphony doctor --goal --config/);

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
