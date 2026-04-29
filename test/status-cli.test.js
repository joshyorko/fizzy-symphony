import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runStatusCommand } from "../src/status-cli.js";

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
  assert.match(io.stdout.text, /Instance: instance-a \(local\)/);
  assert.match(io.stdout.text, /Ready: yes/);
  assert.match(io.stdout.text, /Runner: cli_app_server ready/);
  assert.match(io.stdout.text, /Active runs: 1/);
  assert.match(io.stdout.text, /Claims: 1/);
  assert.match(io.stdout.text, /Recent completions: 1/);
  assert.match(io.stdout.text, /Recent failures: 1/);
  assert.match(io.stdout.text, /Validation warnings: 1/);
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
