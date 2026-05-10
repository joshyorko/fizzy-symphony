import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { renderStatus, runStatusCommand } from "../src/status-cli.js";
import { runDashboardCommand } from "../src/dashboard.js";

function ioCapture() {
  return {
    stdout: { text: "", write(chunk) { this.text += chunk; } },
    stderr: { text: "", write(chunk) { this.text += chunk; } }
  };
}

function statusSnapshot() {
  return {
    instance: { id: "instance-a", label: "local" },
    endpoint: { base_url: "http://127.0.0.1:4567" },
    readiness: { ready: true },
    runner_health: { status: "ready", kind: "cli_app_server" },
    watched_boards: [{ id: "board_1", label: "Agents" }],
    active_runs: [{ id: "run_1", card_number: 42, status: "running" }],
    claims: [{ id: "claim_1", card_id: "card_1", status: "claimed" }],
    workpads: [{ card_id: "card_1", comment_id: "comment_workpad", updated_at: "2026-04-29T12:00:00.000Z" }],
    retry_queue: [{ run_id: "run_retry" }],
    recent_completions: [{ run_id: "run_done", card_id: "card_done" }],
    recent_failures: [{ run_id: "run_failed", card_id: "card_failed" }],
    validation: { warnings: [{ code: "ENTROPY_UNKNOWN" }], errors: [] },
    token_rate_limit: { available: true, fizzy: { remaining: 9, limit: 10 } }
  };
}

test("status CLI discovers an instance endpoint and prints operator-readable status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-status-cli-"));
  await writeFile(
    join(dir, "instance-a.json"),
    `${JSON.stringify({
      schema_version: "fizzy-symphony-instance-v1",
      instance_id: "instance-a",
      label: "local",
      endpoint: { base_url: "http://127.0.0.1:4567" },
      updated_at: "2026-04-29T12:00:00.000Z"
    })}\n`,
    "utf8"
  );
  const io = ioCapture();
  const requested = [];

  const exitCode = await runStatusCommand(["--registry-dir", dir], io, {
    fetch: async (url) => {
      requested.push(url);
      return { ok: true, json: async () => statusSnapshot() };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requested, ["http://127.0.0.1:4567/status"]);
  assert.match(io.stdout.text, /Fizzy Symphony Status/u);
  assert.match(io.stdout.text, /instance-a \(local\)/);
  assert.match(io.stdout.text, /\[READY\]/u);
  assert.match(io.stdout.text, /Runner\s+cli_app_server ready/u);
  assert.match(io.stdout.text, /Boards\s+1/u);
  assert.match(io.stdout.text, /Active runs\s+1/u);
  assert.match(io.stdout.text, /Claims\s+1/u);
  assert.match(io.stdout.text, /Recent completions\s+1/u);
  assert.match(io.stdout.text, /Recent failures\s+1/u);
  assert.match(io.stdout.text, /Validation warnings\s+1/u);
  assert.doesNotMatch(io.stdout.text, /\x1b\[/u);
});

test("renderStatus preserves every operator fact in a scannable premium layout", () => {
  const rendered = renderStatus(statusSnapshot(), {
    endpoint: "http://127.0.0.1:4567",
    color: false
  });

  assert.match(rendered, /Fizzy Symphony Status/u);
  assert.match(rendered, /Endpoint\s+http:\/\/127\.0\.0\.1:4567/u);
  assert.match(rendered, /Readiness\s+\[READY\]/u);
  assert.match(rendered, /Runner\s+cli_app_server ready/u);
  assert.match(rendered, /Boards\s+1/u);
  assert.match(rendered, /Active runs\s+1/u);
  assert.match(rendered, /Claims\s+1/u);
  assert.match(rendered, /Workpads\s+1/u);
  assert.match(rendered, /Retry queue\s+1/u);
  assert.match(rendered, /Recent completions\s+1/u);
  assert.match(rendered, /Recent failures\s+1/u);
  assert.match(rendered, /Validation warnings\s+1/u);
  assert.match(rendered, /Validation errors\s+0/u);
  assert.match(rendered, /Token\/rate metadata\s+available/u);
});

test("status CLI exits 3 with a clear message when no live instance is reachable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-status-cli-empty-"));
  const io = ioCapture();

  const exitCode = await runStatusCommand(["--registry-dir", dir, "--no-default-endpoint"], io, {
    fetch: async () => {
      throw new Error("fetch should not run without discovered endpoints");
    }
  });

  assert.equal(exitCode, 3);
  assert.match(io.stderr.text, /No live fizzy-symphony instance found/);
});

test("dashboard CLI uses the same status discovery and prints non-TTY dashboard fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-dashboard-cli-"));
  await writeFile(
    join(dir, "instance-a.json"),
    `${JSON.stringify({
      instance_id: "instance-a",
      endpoint: { base_url: "http://127.0.0.1:4567" },
      updated_at: "2026-04-29T12:00:00.000Z"
    })}\n`,
    "utf8"
  );
  const io = ioCapture();

  const exitCode = await runDashboardCommand(["--registry-dir", dir, "--once"], io, {
    fetch: async () => ({ ok: true, json: async () => statusSnapshot() })
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout.text, /fizzy-symphony dashboard/u);
  assert.match(io.stdout.text, /Boards: 1/u);
  assert.match(io.stdout.text, /Active runs: 1/u);
  assert.match(io.stdout.text, /Recent failures: 1/u);
});

test("dashboard CLI discovers endpoints from --config registry before default endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-dashboard-config-"));
  const registryDir = join(dir, "instances");
  const configPath = join(dir, "config.json");
  await mkdir(registryDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    server: { registry_dir: registryDir, heartbeat_interval_ms: 1000 }
  })}\n`, "utf8");
  await writeFile(join(registryDir, "instance-b.json"), `${JSON.stringify({
    instance_id: "instance-b",
    pid: process.pid,
    endpoint: { base_url: "http://127.0.0.1:49171" },
    heartbeat_at: "2026-04-29T12:00:04.000Z"
  })}\n`, "utf8");
  const io = {
    ...ioCapture(),
    env: { FIZZY_API_TOKEN: "token" },
    now: () => new Date("2026-04-29T12:00:05.000Z"),
    isPidAlive: () => true
  };
  const requested = [];

  const exitCode = await runDashboardCommand(["--config", configPath, "--instance", "instance-b", "--once"], io, {
    fetch: async (url) => {
      requested.push(url);
      return { ok: true, json: async () => statusSnapshot() };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requested, ["http://127.0.0.1:49171/status"]);
  assert.match(io.stdout.text, /fizzy-symphony dashboard/u);
});
