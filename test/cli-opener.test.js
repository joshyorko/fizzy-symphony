import test from "node:test";
import assert from "node:assert/strict";

import {
  OPENER_LINE_COUNT,
  OPENER_WIDTH,
  renderColorOpener,
  renderOpenerFrames,
  renderPlainOpener,
  resolveOpenerOptions,
  shouldAnimateOpener,
  stripAnsi,
  visualLines
} from "../src/cli-opener.js";

test("plain opener renders the Fizzy Symphony board without ANSI", () => {
  const rendered = renderPlainOpener();

  assert.equal(rendered.includes("\x1b["), false);
  assert.match(rendered, /FIZZY SYMPHONY/u);
  assert.match(rendered, /GOLDEN TICKET/u);
  assert.match(rendered, /Ready for Agents/u);
  assert.match(rendered, /[♪♫♬♩]/u);
  assert.deepEqual(visualLines(rendered), {
    width: OPENER_WIDTH,
    lines: OPENER_LINE_COUNT
  });
});

test("colored opener keeps stable dimensions while emitting ANSI", () => {
  const plain = renderPlainOpener();
  const colored = renderColorOpener();

  assert.match(colored, /\x1b\[/u);
  assert.equal(stripAnsi(colored), plain);
  assert.deepEqual(visualLines(colored), {
    width: OPENER_WIDTH,
    lines: OPENER_LINE_COUNT
  });
});

test("compact opener is selectable and dimensionally stable", () => {
  const rendered = renderPlainOpener({ banner: "compact" });
  const dimensions = visualLines(rendered);

  assert.match(rendered, /FIZZY SYMPHONY/u);
  assert.equal(dimensions.width < OPENER_WIDTH, true);
  assert.equal(dimensions.lines < OPENER_LINE_COUNT, true);
});

test("invalid opener environment values fall back safely", () => {
  const options = resolveOpenerOptions({
    FIZZY_SYMPHONY_ANIM: "sideways",
    FIZZY_SYMPHONY_BANNER: "poster"
  }, { isTTY: true });

  assert.equal(options.animation, "pop");
  assert.equal(options.banner, "full");
  assert.equal(options.animate, true);
});

test("animation gating depends on TTY, TERM, CI, and NO_COLOR", () => {
  assert.equal(shouldAnimateOpener({
    animation: "pop",
    env: { TERM: "xterm-256color" },
    stdout: { isTTY: true }
  }), true);
  assert.equal(shouldAnimateOpener({
    animation: "pop",
    env: { TERM: "xterm-256color", CI: "true" },
    stdout: { isTTY: true }
  }), false);
  assert.equal(shouldAnimateOpener({
    animation: "pop",
    env: { TERM: "xterm-256color", NO_COLOR: "1" },
    stdout: { isTTY: true }
  }), false);
  assert.equal(shouldAnimateOpener({
    animation: "pop",
    env: { TERM: "dumb" },
    stdout: { isTTY: true }
  }), false);
  assert.equal(shouldAnimateOpener({
    animation: "pop",
    env: { TERM: "xterm-256color" },
    stdout: { isTTY: false }
  }), false);
  assert.equal(shouldAnimateOpener({
    animation: "none",
    env: { TERM: "xterm-256color" },
    stdout: { isTTY: true }
  }), false);
});

test("pop and paint animation frames reveal the same final board differently", () => {
  const pop = renderOpenerFrames({ animation: "pop", color: false, frameCount: 8 });
  const paint = renderOpenerFrames({ animation: "paint", color: false, frameCount: 8 });

  assert.equal(pop.length, 8);
  assert.equal(paint.length, 8);
  assert.notEqual(pop[0], paint[0]);
  assert.equal(pop.at(-1), renderPlainOpener());
  assert.equal(paint.at(-1), renderPlainOpener());
  for (const frame of [...pop, ...paint]) {
    assert.deepEqual(visualLines(frame), {
      width: OPENER_WIDTH,
      lines: OPENER_LINE_COUNT
    });
  }
});
