import test from "node:test";
import assert from "node:assert/strict";

import { createTerminalRenderer, supportsColor } from "../src/terminal-renderer.js";

test("terminal renderer provides branded plain-text building blocks", () => {
  const renderer = createTerminalRenderer({ color: false });

  const rendered = [
    renderer.title("Fizzy Symphony Status", "Board-native agent workflow"),
    renderer.section("Health"),
    renderer.kvRows([
      ["Instance", "instance-a"],
      ["Ready", renderer.badge("success", "ready")]
    ]),
    renderer.table(["Board", "Cards"], [["Agents", "2"]]),
    renderer.callout("warning", "Needs attention", ["Fix the config, then rerun status."])
  ].join("\n");

  assert.match(rendered, /Fizzy Symphony Status/u);
  assert.match(rendered, /Board-native agent workflow/u);
  assert.match(rendered, /Health/u);
  assert.match(rendered, /Instance\s+instance-a/u);
  assert.match(rendered, /\[READY\]/u);
  assert.match(rendered, /Board\s+Cards/u);
  assert.match(rendered, /Needs attention/u);
  assert.doesNotMatch(rendered, /\x1b\[/u);
});

test("supportsColor stays off for NO_COLOR, CI, non-TTY, and dumb terminals", () => {
  assert.equal(supportsColor({ TERM: "xterm-256color" }, { isTTY: true }), true);
  assert.equal(supportsColor({ TERM: "xterm-256color", NO_COLOR: "1" }, { isTTY: true }), false);
  assert.equal(supportsColor({ TERM: "xterm-256color", CI: "true" }, { isTTY: true }), false);
  assert.equal(supportsColor({ TERM: "xterm-256color" }, { isTTY: false }), false);
  assert.equal(supportsColor({ TERM: "dumb" }, { isTTY: true }), false);
});
