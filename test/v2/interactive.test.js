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

test("DEMO refuses to dispatch mutating actions (no command, no event)", async () => {
  // A fixture is not a daemon: a mutating action in DEMO must be disabled
  // behaviorally, not merely relabeled. The same fixture in LIVE still dry-runs.
  const term = fakeTerminal();
  const runtime = loadRuntime("running-one-card.json");
  const session = await startInteractiveCockpit({
    runtime,
    app: { mode: "DEMO", source: "fixture running-one-card.json", configPath: "/x/config.yml" },
    terminalFactory: async () => term
  });
  session.handleKey("DOWN"); // select card_426 (has runId/sessionId)
  assert.equal(session.currentModel().selected.raw.runId, "run_426");

  // Direct key and palette dispatch both route through submit(); neither acts.
  session.handleKey("c"); // run.cancel
  assert.match(term.frames.at(-1), /disabled/i);
  assert.match(term.frames.at(-1), /fixture data \(DEMO\)/);

  session.handleKey("CTRL_P");
  session.handleKey("A");
  session.handleKey("c");
  assert.match(term.frames.at(-1), /disabled/i);

  // Nothing was enqueued: no dry-run event was emitted for the cancel.
  assert.ok(
    !runtime.getEvents(20).some((event) => event.type === "command.dry-run.run.cancel"),
    "DEMO must not produce a dry-run command event"
  );

  session.handleKey("q");
  await session.done;
});

test("interactive / filter narrows lane cards live, Enter keeps, Esc clears", async () => {
  const term = fakeTerminal();
  const runtime = loadRuntime("running-multiple-cards.json");
  const session = await startInteractiveCockpit({
    runtime,
    app: { mode: "LIVE", source: "x", configPath: "/x", endpoint: "http://127.0.0.1:4510" },
    terminalFactory: async () => term
  });
  const cardCount = () => session.currentModel().lanes.flatMap((lane) => lane.cards).length;
  const before = cardCount();
  assert.ok(before > 1, "fixture should have several cards");

  session.handleKey("/"); // enter capture
  assert.match(term.frames.at(-1), /filter:/);
  for (const ch of "cockpit") session.handleKey(ch); // selective term
  const narrowed = cardCount();
  assert.ok(narrowed < before, "typing should narrow the visible cards");
  assert.match(term.frames.at(-1), new RegExp(`${narrowed} match`));

  session.handleKey("BACKSPACE"); // edits the draft, stays in capture
  assert.match(term.frames.at(-1), /filter: cockpi▏/u);

  session.handleKey("ENTER"); // apply
  assert.match(term.frames.at(-1), /filter "cockpi"/);
  assert.ok(cardCount() < before, "applied filter persists");

  session.handleKey("/"); // re-open, then cancel
  session.handleKey("ESCAPE");
  assert.equal(cardCount(), before, "Esc clears the filter");
  // Esc in filter mode must NOT quit the session.
  assert.equal(session.currentModel().selectedSectionId, "factory");

  // Navigation works again after exiting filter mode.
  session.handleKey("2");
  assert.equal(session.currentModel().selectedSectionId, "runs");

  session.handleKey("q");
  await session.done;
});

test("Esc closes the command palette instead of quitting the session", async () => {
  const term = fakeTerminal();
  const runtime = loadRuntime("running-multiple-cards.json");
  const session = await startInteractiveCockpit({ runtime, terminalFactory: async () => term });
  session.handleKey("CTRL_P");
  assert.equal(session.currentModel().commandPaletteOpen, true);
  session.handleKey("ESCAPE"); // dismiss overlay, must NOT quit
  assert.equal(session.currentModel().commandPaletteOpen, false);
  assert.match(term.frames.at(-1), /Command palette closed/);
  // Session is still alive: navigation works.
  session.handleKey("2");
  assert.equal(session.currentModel().selectedSectionId, "runs");
  session.handleKey("q");
  await session.done;
});

test("Ctrl-C quits even while the filter is capturing", async () => {
  const term = fakeTerminal();
  const runtime = loadRuntime("running-multiple-cards.json");
  const session = await startInteractiveCockpit({ runtime, terminalFactory: async () => term });
  session.handleKey("/"); // enter capture
  session.handleKey("CTRL_C"); // universal escape hatch must still quit
  await session.done; // resolves — otherwise this test hangs
  assert.ok(true);
});
