import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createCockpitModel } from "../../src/v2/cockpit/model.ts";
import { renderCockpitText } from "../../src/v2/cockpit/renderer.ts";
import { normalizeStatus } from "../../src/v2/core/status.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "v2");
const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));

test("every fixture loads, normalizes, and renders without throwing", () => {
  assert.ok(fixtures.length >= 11, `expected >= 11 fixtures, found ${fixtures.length}`);
  for (const name of fixtures) {
    const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
    const status = normalizeStatus(raw.status);
    const model = createCockpitModel({ status, events: raw.events ?? [] });
    const text = renderCockpitText(model);
    assert.match(text, /FIZZY-SYMPHONY/, `fixture ${name} should render header`);
    assert.match(text, /Actions/, `fixture ${name} should render actions`);
  }
});

test("hazard states are visually obvious in rendered text", () => {
  const dirty = JSON.parse(readFileSync(join(FIXTURE_DIR, "dirty-worktree.json"), "utf8"));
  const dirtyModel = createCockpitModel({ status: normalizeStatus(dirty.status), selectedSectionId: "worktrees" });
  assert.match(renderCockpitText(dirtyModel), /Spill \/ hazard/);

  const failed = JSON.parse(readFileSync(join(FIXTURE_DIR, "failed-run.json"), "utf8"));
  const failedModel = createCockpitModel({ status: normalizeStatus(failed.status), selectedSectionId: "runs" });
  assert.match(renderCockpitText(failedModel), /Jammed machine|RUNNER_ERROR/);

  const blocked = JSON.parse(readFileSync(join(FIXTURE_DIR, "blocked-runner.json"), "utf8"));
  const blockedModel = createCockpitModel({ status: normalizeStatus(blocked.status), selectedSectionId: "doctor" });
  assert.match(renderCockpitText(blockedModel), /Factory cannot close/);
});

test("attention strip surfaces the highest-priority hazard", () => {
  const dirty = JSON.parse(readFileSync(join(FIXTURE_DIR, "dirty-worktree.json"), "utf8"));
  const dirtyModel = createCockpitModel({ status: normalizeStatus(dirty.status) });
  assert.match(renderCockpitText(dirtyModel), /Factory cannot close/);
});

test("non-TTY render is ANSI-free, color render emits truecolor escapes", () => {
  const ready = JSON.parse(readFileSync(join(FIXTURE_DIR, "running-one-card.json"), "utf8"));
  const model = createCockpitModel({ status: normalizeStatus(ready.status) });
  assert.doesNotMatch(renderCockpitText(model), /\x1b\[/);
  assert.match(renderCockpitText(model, { color: true }), /\x1b\[38;2;/);
});

test("width option scales the frame rule", () => {
  const ready = JSON.parse(readFileSync(join(FIXTURE_DIR, "running-one-card.json"), "utf8"));
  const model = createCockpitModel({ status: normalizeStatus(ready.status) });
  const narrow = renderCockpitText(model, { width: 48 }).split("\n")[0];
  const wide = renderCockpitText(model, { width: 120 }).split("\n")[0];
  assert.equal(narrow.length, 48);
  assert.equal(wide.length, 120);
});

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/gu, "");
const visibleWidth = (line) => [...stripAnsi(line)].length;

test("header, attention, counts, and section rail never overrun width (40/80/120)", () => {
  const ready = JSON.parse(readFileSync(join(FIXTURE_DIR, "running-one-card.json"), "utf8"));
  const model = createCockpitModel({ status: normalizeStatus(ready.status), events: ready.events ?? [] });
  for (const width of [40, 80, 120]) {
    const lines = renderCockpitText(model, { width }).split("\n");
    // Frame rules are exactly the requested width.
    assert.equal(visibleWidth(lines[0]), width, `frame should equal width ${width}`);
    // The critical glance region: header (6) + attention + counts + blank + rail.
    const critical = lines.slice(0, 10);
    for (const line of critical) {
      assert.ok(
        visibleWidth(line) <= width,
        `line "${stripAnsi(line)}" (${visibleWidth(line)}) exceeds width ${width}`
      );
    }
  }
});

test("DEMO shows the fixture source, never a fixture endpoint as a live daemon", () => {
  const ready = JSON.parse(readFileSync(join(FIXTURE_DIR, "running-one-card.json"), "utf8"));
  const model = createCockpitModel({
    status: normalizeStatus(ready.status),
    events: ready.events ?? [],
    app: {
      mode: "DEMO",
      source: "fixture /abs/path/running-one-card.json",
      configPath: "/abs/.fizzy-symphony/config.yml",
      endpoint: "http://127.0.0.1:4567"
    }
  });
  const text = stripAnsi(renderCockpitText(model));
  assert.match(text, /\[ DEMO \]/);
  assert.match(text, /source .*fixture/);
  assert.match(text, /demo data/);
  // The embedded endpoint must not be presented on a "daemon ●" live line.
  assert.doesNotMatch(text, /daemon ● http:\/\/127\.0\.0\.1:4567/);
});

test("DEMO source line preserves the demo-data label with long fixture paths", () => {
  const ready = JSON.parse(readFileSync(join(FIXTURE_DIR, "ready.json"), "utf8"));
  const model = createCockpitModel({
    status: normalizeStatus(ready.status),
    app: {
      mode: "DEMO",
      source:
        "fixture /var/home/kdlocpanda/second_brain/Resources/virtualization/docker/37signals/agent_stuff/fizzy-symphony/src/v2/fixtures/ready.json",
      configPath: "/abs/.fizzy-symphony/config.yml"
    }
  });
  const sourceLine = stripAnsi(renderCockpitText(model, { width: 100 }))
    .split("\n")
    .find((line) => line.includes("source"));
  assert.ok(sourceLine, "expected a DEMO source line");
  assert.match(sourceLine, /\(demo data\)/);
  assert.ok(visibleWidth(sourceLine) <= 100, `source line exceeds width: ${sourceLine}`);
});

test("SETUP and OFFLINE never show live mutating actions as ready", () => {
  const ready = JSON.parse(readFileSync(join(FIXTURE_DIR, "running-one-card.json"), "utf8"));
  const status = normalizeStatus(ready.status);
  for (const mode of ["SETUP", "OFFLINE"]) {
    const model = createCockpitModel({
      status,
      app: { mode, source: `config /abs/config.yml`, configPath: "/abs/config.yml", endpoint: undefined }
    });
    const text = stripAnsi(renderCockpitText(model));
    const actionsBlock = text.slice(text.indexOf(" Actions "));
    // Every mutating action line (marked ↯) must read "off ·", never "ready".
    for (const line of actionsBlock.split("\n")) {
      if (line.includes("↯") && /\[[a-zA-Z]\]/.test(line)) {
        assert.match(line, /off ·/, `${mode}: mutating action should be disabled: ${line}`);
        assert.doesNotMatch(line, /\bready\b/, `${mode}: mutating action must not be ready: ${line}`);
      }
    }
    // Guidance-only shell commands remain visible.
    assert.match(text, /Next in your shell/);
  }
});

test("DEMO marks mutating actions as demo data, never live-ready", () => {
  // A fixture is not a daemon, so a mutating action in DEMO must read "demo"
  // (fixture data) and never the live-ready "ready" — in actions and palette.
  const ready = JSON.parse(readFileSync(join(FIXTURE_DIR, "running-one-card.json"), "utf8"));
  const model = createCockpitModel({
    status: normalizeStatus(ready.status),
    selectedId: "card_426", // gives run.cancel/session.stop a valid live target
    commandPaletteOpen: true,
    app: { mode: "DEMO", source: "fixture running-one-card.json", configPath: "/abs/config.yml" }
  });
  const text = stripAnsi(renderCockpitText(model));
  for (const line of text.split("\n")) {
    // mutating action rows are marked ↯ and carry an action key like [c] or A:c
    if (line.includes("↯") && /(\[[a-zA-Z]\]|A:[a-zA-Z])/.test(line)) {
      assert.match(line, /demo ·/, `DEMO mutating action should read demo: ${line}`);
      assert.doesNotMatch(line, /\bready\b/, `DEMO mutating action must not be ready: ${line}`);
    }
  }
});

test("command palette explains its prefix convention", () => {
  const ready = JSON.parse(readFileSync(join(FIXTURE_DIR, "ready.json"), "utf8"));
  const model = createCockpitModel({
    status: normalizeStatus(ready.status),
    commandPaletteOpen: true
  });
  const text = stripAnsi(renderCockpitText(model));
  assert.match(text, /A:key action/);
  assert.match(text, /V:key command/);
  assert.match(text, /Esc closes/);
});

test("event severity is distinguishable without color (no color-only semantics)", () => {
  // info/warning/error must carry a distinct glyph, not just a tint, so the
  // distinction survives NO_COLOR / monochrome terminals.
  const wh = JSON.parse(readFileSync(join(FIXTURE_DIR, "webhook-error.json"), "utf8"));
  const model = createCockpitModel({
    status: normalizeStatus(wh.status),
    events: wh.events ?? [],
    selectedSectionId: "events"
  });
  const text = stripAnsi(renderCockpitText(model)); // color OFF
  const eventsBlock = text.slice(text.indexOf(" Events "));
  // error rows carry ✗, info rows carry ◆ — both present and different.
  assert.match(eventsBlock, /✗/, "error severity needs a distinct glyph under no-color");
  assert.match(eventsBlock, /◆/, "info severity needs a distinct glyph under no-color");
});

test("no rendered line overruns the frame at any width (copyable commands exempt)", () => {
  // The width clamp is the final hard guarantee: at any width, every line fits
  // the frame except copyable "$ <command>" lines, which must stay verbatim so
  // an operator can paste them. Exercise every fixture, every section, palette
  // open, with a selection (the densest, longest-content frames).
  const sections = ["factory", "runs", "worktrees", "doctor", "manual", "events", "settings", "advanced"];
  for (const name of fixtures) {
    const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
    const status = normalizeStatus(raw.status);
    const selectedId = status.cards[0]?.id ?? status.worktrees[0]?.workspaceKey;
    for (const width of [40, 56, 80, 120]) {
      for (const selectedSectionId of sections) {
        const model = createCockpitModel({
          status,
          events: raw.events ?? [],
          selectedId,
          selectedSectionId,
          commandPaletteOpen: true
        });
        const lines = renderCockpitText(model, { width }).split("\n");
        // Frame rules are exactly the requested width.
        assert.equal(visibleWidth(lines[0]), width, `${name} @${width}: frame should equal width`);
        for (const line of lines) {
          const plain = stripAnsi(line);
          const isCopyable = plain.trimStart().startsWith("$ ");
          if (!isCopyable) {
            assert.ok(
              visibleWidth(line) <= width,
              `${name} @${width} (${selectedSectionId}): "${plain}" (${visibleWidth(line)}) exceeds width`
            );
          }
        }
      }
    }
  }
});

test("copyable shell commands are preserved verbatim (not ellipsized)", () => {
  // A long absolute config path would overrun 80 cols; the guidance command
  // must keep the full path so it pastes correctly.
  const ready = JSON.parse(readFileSync(join(FIXTURE_DIR, "ready.json"), "utf8"));
  const longPath = "/very/long/absolute/path/to/some/deeply/nested/workspace/.fizzy-symphony/config.yml";
  const model = createCockpitModel({
    status: normalizeStatus(ready.status),
    app: { mode: "OFFLINE", source: "config", configPath: longPath, endpoint: undefined }
  });
  const text = stripAnsi(renderCockpitText(model, { width: 80 }));
  assert.match(text, new RegExp(`\\$ fizzy-symphony start --config ${longPath.replace(/[/.]/gu, "\\$&")}`));
  assert.doesNotMatch(text, /fizzy-symphony start --config \S*…/);
});
