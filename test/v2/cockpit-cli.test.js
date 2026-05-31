import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { runCockpitCommand } from "../../src/v2/cli/cockpit.ts";
import { runCapabilitiesCommand } from "../../src/v2/cli/capabilities.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "v2");
const PACKAGED_READY_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "v2", "fixtures", "ready.json");

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
  assert.match(out(), /Mode: DEMO/);
  assert.match(out(), /FIZZY-SYMPHONY COCKPIT/);
  assert.match(out(), /Machine in motion/);
  assert.match(out(), /run_426/);
});

test("cockpit --fixture packaged ready data stays DEMO", async () => {
  assert.equal(existsSync(PACKAGED_READY_FIXTURE), true);
  const { io, out } = bufferIo({
    stdoutIsTTY: false,
    fetch: async () => ({ ok: false, status: 404 })
  });
  const code = await runCockpitCommand(["--fixture", PACKAGED_READY_FIXTURE, "--once"], io);
  assert.equal(code, 0);
  assert.match(out(), /Mode: DEMO/);
  assert.match(out(), /Factory open/);
});

test("cockpit without config enters setup without external clients", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-v2-cockpit-"));
  const requested = [];
  const { io, out } = bufferIo({
    stdoutIsTTY: false,
    fetch: async (url) => {
      requested.push(String(url));
      return { ok: true, json: async () => ({}) };
    }
  });

  const code = await runCockpitCommand(["--config", join(dir, "config.yml"), "--once"], io);
  assert.equal(code, 0);
  assert.equal(requested.length, 0);
  assert.match(out(), /Mode: SETUP/);
  assert.match(out(), /setup/);
});

test("cockpit with config exists but no daemon/default disabled enters OFFLINE", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-v2-cockpit-offline-"));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, `${JSON.stringify({
    server: { registry_dir: dir, host: "127.0.0.1", port: 4567 }
  })}\n`, "utf8");
  const { io, out } = bufferIo({
    stdoutIsTTY: false
  });
  const code = await runCockpitCommand([
    "--config",
    configPath,
    "--registry-dir",
    dir,
    "--no-default-endpoint",
    "--once"
  ], io);
  assert.equal(code, 0);
  assert.match(out(), /Mode: OFFLINE/);
  assert.match(out(), /start.*daemon/i);
});

test("cockpit with config can reach LIVE through default endpoint fallback without secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-v2-cockpit-default-live-"));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, `${JSON.stringify({
    server: { registry_dir: join(dir, "empty-registry"), host: "127.0.0.1", port: 4567 }
  })}\n`, "utf8");
  const bundle = JSON.parse(await readFile(join(FIXTURE_DIR, "running-one-card.json"), "utf8"));
  const requested = [];
  const { io, out } = bufferIo({
    stdoutIsTTY: false,
    fetch: async (url) => {
      requested.push(String(url));
      return {
        ok: true,
        json: async () => String(url).endsWith("/v2/events") ? { events: bundle.events ?? [] } : bundle.status
      };
    }
  });

  const code = await runCockpitCommand(["--config", configPath, "--once"], io);

  assert.equal(code, 0);
  assert.deepEqual(requested, [
    "http://127.0.0.1:4567/v2/status",
    "http://127.0.0.1:4567/v2/events"
  ]);
  assert.match(out(), /Mode: LIVE/);
  assert.match(out(), /run_426/);
});

test("cockpit with config enters OFFLINE when default endpoint is unreachable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-v2-cockpit-default-offline-"));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, `${JSON.stringify({
    server: { registry_dir: join(dir, "empty-registry"), host: "127.0.0.1", port: 4567 }
  })}\n`, "utf8");
  const requested = [];
  const { io, out } = bufferIo({
    stdoutIsTTY: false,
    fetch: async (url) => {
      requested.push(String(url));
      return { ok: false, status: 503, json: async () => ({}) };
    }
  });

  const code = await runCockpitCommand(["--config", configPath, "--once"], io);

  assert.equal(code, 0);
  assert.deepEqual(requested, ["http://127.0.0.1:4567/v2/status"]);
  assert.match(out(), /Mode: OFFLINE/);
  assert.match(out(), /start.*daemon/i);
});

test("cockpit --endpoint strict failure exits nonzero and does not fall back", async () => {
  const requested = [];
  const { io, err } = bufferIo({
    stdoutIsTTY: false,
    fetch: async (url) => {
      requested.push(String(url));
      return { ok: false, status: 503, json: async () => ({}) };
    }
  });

  const code = await runCockpitCommand(["--endpoint", "http://127.0.0.1:49203", "--once"], io);
  assert.equal(code, 1);
  assert.match(err(), /failed to load source/);
  assert.deepEqual(requested, ["http://127.0.0.1:49203/v2/status"]);
});

test("cockpit with config discovers a live v2 daemon from the registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-v2-cockpit-"));
  const configPath = join(dir, "config.json");
  const endpoint = "http://127.0.0.1:49177";
  const now = new Date().toISOString();
  await writeFile(configPath, `${JSON.stringify({ server: { registry_dir: dir } })}\n`, "utf8");
  await writeFile(join(dir, "instance-a.json"), `${JSON.stringify({
    instance_id: "instance-a",
    endpoint: { base_url: endpoint },
    heartbeat_at: now,
    updated_at: now
  })}\n`, "utf8");
  const bundle = JSON.parse(await readFile(join(FIXTURE_DIR, "running-one-card.json"), "utf8"));
  const requested = [];
  const { io, out, err } = bufferIo({
    stdoutIsTTY: false,
    fetch: async (url) => {
      requested.push(url);
      return {
        ok: true,
        json: async () => url.endsWith("/v2/events") ? { events: bundle.events ?? [] } : bundle.status
      };
    }
  });

  const code = await runCockpitCommand([
    "--config",
    configPath,
    "--registry-dir",
    dir,
    "--no-default-endpoint",
    "--once"
  ], io);

  assert.equal(code, 0);
  assert.deepEqual(requested, [`${endpoint}/v2/status`, `${endpoint}/v2/events`]);
  assert.match(out(), /Mode: LIVE/);
  assert.match(out(), /run_426/);
  assert.equal(err(), "");
});

test("cockpit falls back to static text in non-TTY without --once", async () => {
  const { io, out, err } = bufferIo({ stdoutIsTTY: false });
  const code = await runCockpitCommand(["--fixture", join(FIXTURE_DIR, "blocked-runner.json")], io);
  assert.equal(code, 0);
  assert.match(err(), /non-TTY detected/);
  assert.match(out(), /Mode: DEMO/);
  assert.match(out(), /Factory cannot close|blocked/);
});

test("cockpit --json emits a wrapped response with mode", async () => {
  const { io, out } = bufferIo({ stdoutIsTTY: false });
  const code = await runCockpitCommand(["--fixture", join(FIXTURE_DIR, "dirty-worktree.json"), "--json"], io);
  assert.equal(code, 0);
  const payload = JSON.parse(out());
  assert.equal(payload.app, "cockpit");
  assert.equal(payload.mode, "DEMO");
  assert.ok(payload.model.header);
  assert.ok(payload.model.panels.worktrees.some((w) => w.dirty));
});

test("cockpit reports a clear error for a missing fixture", async () => {
  const { io, err } = bufferIo({ stdoutIsTTY: false });
  const code = await runCockpitCommand(["--fixture", join(FIXTURE_DIR, "does-not-exist.json"), "--once"], io);
  assert.equal(code, 1);
  assert.match(err(), /failed to load source/);
});

test("capabilities prints the registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-v2-static-capabilities-"));
  const { io, out } = bufferIo();
  const code = await runCapabilitiesCommand(["--registry-dir", dir, "--no-default-endpoint"], io);
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

test("capabilities with no explicit source discovers a live v2 daemon from the registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-v2-capabilities-"));
  const endpoint = "http://127.0.0.1:49178";
  await writeFile(join(dir, "instance-a.json"), `${JSON.stringify({
    instance_id: "instance-a",
    endpoint: { base_url: endpoint },
    updated_at: "2026-04-29T12:00:00.000Z"
  })}\n`, "utf8");
  const bundle = JSON.parse(await readFile(join(FIXTURE_DIR, "blocked-runner.json"), "utf8"));
  const requested = [];
  const { io, out } = bufferIo({
    fetch: async (url) => {
      requested.push(url);
      return { ok: true, json: async () => bundle.status };
    }
  });

  const code = await runCapabilitiesCommand(["--registry-dir", dir, "--no-default-endpoint", "--json"], io);

  assert.equal(code, 0);
  assert.deepEqual(requested, [`${endpoint}/v2/status`]);
  const { capabilities } = JSON.parse(out());
  const run = capabilities.find((c) => c.id === "codex.run");
  assert.equal(run.enabled, false);
  assert.match(run.disabledReason, /runner/i);
});
