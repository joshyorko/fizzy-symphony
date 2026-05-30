import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runCockpitCommand } from "../../src/v2/cli/cockpit.ts";
import { runCapabilitiesCommand } from "../../src/v2/cli/capabilities.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "v2");

function bufferIo(extra = {}) {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: { write: (t) => out.push(t) },
      stderr: { write: (t) => err.push(t) },
      ...extra
    },
    out: () => out.join(""),
    err: () => err.join("")
  };
}

test("cockpit --once prints a static frame (non-TTY safe)", async () => {
  const { io, out } = bufferIo({ stdoutIsTTY: false });
  const code = await runCockpitCommand(["--fixture", join(FIXTURE_DIR, "running-one-card.json"), "--once"], io);
  assert.equal(code, 0);
  assert.match(out(), /FIZZY-SYMPHONY COCKPIT/);
  assert.match(out(), /Machine in motion/);
  assert.match(out(), /run_426/);
});

test("cockpit falls back to static text in non-TTY without --once", async () => {
  const { io, out, err } = bufferIo({ stdoutIsTTY: false });
  const code = await runCockpitCommand(["--fixture", join(FIXTURE_DIR, "blocked-runner.json")], io);
  assert.equal(code, 0);
  assert.match(err(), /non-TTY detected/);
  assert.match(out(), /Factory cannot close|blocked/);
});

test("cockpit --json emits the cockpit model", async () => {
  const { io, out } = bufferIo({ stdoutIsTTY: false });
  const code = await runCockpitCommand(["--fixture", join(FIXTURE_DIR, "dirty-worktree.json"), "--json"], io);
  assert.equal(code, 0);
  const model = JSON.parse(out());
  assert.ok(model.header);
  assert.ok(model.panels.worktrees.some((w) => w.dirty));
});

test("cockpit reports a clear error for a missing fixture", async () => {
  const { io, err } = bufferIo({ stdoutIsTTY: false });
  const code = await runCockpitCommand(["--fixture", join(FIXTURE_DIR, "does-not-exist.json"), "--once"], io);
  assert.equal(code, 1);
  assert.match(err(), /failed to load source/);
});

test("capabilities prints the registry", async () => {
  const { io, out } = bufferIo();
  const code = await runCapabilitiesCommand([], io);
  assert.equal(code, 0);
  assert.match(out(), /codex.run/);
  assert.match(out(), /worktree.preserve/);
});

test("capabilities --json against a fixture reflects live disabled reasons", async () => {
  const { io, out } = bufferIo();
  const code = await runCapabilitiesCommand(["--fixture", join(FIXTURE_DIR, "ready.json"), "--json"], io);
  assert.equal(code, 0);
  const { capabilities } = JSON.parse(out());
  const cancel = capabilities.find((c) => c.id === "codex.cancel");
  assert.equal(cancel.enabled, false);
  assert.equal(cancel.disabledReason, "No active run");
});
