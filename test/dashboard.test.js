import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDashboardModel, renderDashboardText } from "../src/dashboard-model.js";
import { runDashboardCommand } from "../src/dashboard.js";

function statusSnapshot() {
  return {
    instance: { id: "instance-a", label: "local" },
    endpoint: { base_url: "http://127.0.0.1:4567" },
    readiness: { ready: false, blockers: [{ code: "RUNNER_NOT_READY" }] },
    runner_health: { status: "unavailable", kind: "cli_app_server" },
    watched_boards: [{ id: "board_1", label: "Agents" }],
    routes: [{
      id: "route_1",
      board_id: "board_1",
      source_column_id: "ready",
      source_column_name: "Ready for Agents",
      backend: "codex",
      completion: { policy: "move_to_column", target_column_id: "done", target_column_name: "Done" }
    }],
    active_runs: [{
      id: "run_1",
      card: { number: 42, title: "Fix terminal output" },
      status: "running",
      workspace_path: "/work/repo/.fizzy-symphony/worktrees/card-42"
    }],
    claims: [{ id: "claim_1", card_id: "card_1", status: "claimed" }],
    workpads: [{ card_id: "card_1", comment_id: "comment_workpad" }],
    retry_queue: [{ run_id: "run_retry" }],
    recent_completions: [{ run_id: "run_done", card_id: "card_done", completed_at: "2026-04-29T12:05:00.000Z" }],
    recent_failures: [{ run_id: "run_failed", error: { code: "RUNNER_ERROR", message: "runner failed" } }],
    webhook: {
      enabled: true,
      management: { enabled: true, status: "managed" },
      recent_delivery_errors: [{ code: "DELIVERY_FAILED", message: "callback failed" }]
    },
    capacity_refusals: [{ card_id: "card_blocked", reason: "agent capacity reached" }],
    recent_warnings: [{ code: "WORKPAD_UPDATE_FAILED", message: "workpad update failed" }],
    workpad_failures: [{ run_id: "run_1", error: { code: "COMMENT_UPDATE_FAILED" } }],
    cleanup_state: { status: "preserved" },
    validation: { warnings: [{ code: "ENTROPY_UNKNOWN" }], errors: [] },
    last_updated_at: "2026-04-29T12:06:00.000Z"
  };
}

function ioCapture(options = {}) {
  return {
    stdout: {
      text: "",
      isTTY: options.isTTY ?? false,
      write(chunk) { this.text += chunk; }
    },
    stderr: {
      text: "",
      write(chunk) { this.text += chunk; }
    },
    stdin: { isTTY: options.isTTY ?? false },
    env: options.env ?? {}
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("dashboard model summarizes status truth without inventing workflow state", () => {
  const model = createDashboardModel(statusSnapshot(), { endpoint: "http://127.0.0.1:4567" });

  assert.equal(model.title, "fizzy-symphony operator cockpit");
  assert.equal(model.instance.id, "instance-a");
  assert.equal(model.state.label, "BLOCKED");
  assert.equal(model.state.running, true);
  assert.match(model.state.detail, /1 active run/u);
  assert.equal(model.readiness.status, "not ready");
  assert.equal(model.runner.label, "cli_app_server unavailable");
  assert.equal(model.counts.boards, 1);
  assert.equal(model.counts.routes, 1);
  assert.equal(model.counts.activeRuns, 1);
  assert.equal(model.counts.claims, 1);
  assert.equal(model.counts.workpads, 1);
  assert.equal(model.counts.failures, 1);
  assert.equal(model.counts.completions, 1);
  assert.equal(model.counts.webhookErrors, 1);
  assert.equal(model.counts.capacityRefusals, 1);
  assert.equal(model.counts.runtimeWarnings, 1);
  assert.equal(model.counts.workpadFailures, 1);
  assert.equal(model.cleanup.status, "preserved");
  assert.deepEqual(model.workspacePaths, ["/work/repo/.fizzy-symphony/worktrees/card-42"]);
  assert.equal(model.sections.boardWorkflow[0].title, "Agents (board_1)");
  assert.match(model.sections.boardWorkflow[0].rows[0], /Ready for Agents -> Done \(codex\)/u);
  assert.match(model.sections.recentActivity[0], /completed run_done/u);
  assert.match(model.sections.failures.join("\n"), /RUNNER_NOT_READY/u);
});

test("dashboard text fallback renders operator sections for non-TTY output", () => {
  const text = renderDashboardText(createDashboardModel(statusSnapshot()));

  assert.match(text, /fizzy-symphony operator cockpit/u);
  assert.match(text, /State: BLOCKED/u);
  assert.match(text, /Instance: instance-a \(local\)/u);
  assert.match(text, /Runner: cli_app_server unavailable/u);
  assert.match(text, /Counters/u);
  assert.match(text, /Boards: 1/u);
  assert.match(text, /Routes: 1/u);
  assert.match(text, /Active runs: 1/u);
  assert.match(text, /Recent failures: 1/u);
  assert.match(text, /Webhook errors: 1/u);
  assert.match(text, /Capacity refusals: 1/u);
  assert.match(text, /Cleanup: preserved/u);
  assert.match(text, /Board workflow/u);
  assert.match(text, /Agents \(board_1\)/u);
  assert.match(text, /Ready for Agents -> Done \(codex\)/u);
  assert.match(text, /Active work/u);
  assert.match(text, /run_1 #42 Fix terminal output \(running\)/u);
  assert.match(text, /Recent activity/u);
  assert.match(text, /completed run_done/u);
  assert.match(text, /Failures and blockers/u);
  assert.match(text, /RUNNER_NOT_READY/u);
  assert.match(text, /run_failed: RUNNER_ERROR - runner failed/u);
  assert.match(text, /card_blocked: agent capacity reached/u);
  assert.match(text, /Footer/u);
  assert.match(text, /q, Esc, or Ctrl-C/u);
});

test("dashboard model distinguishes running, ready, and blocked states", () => {
  const running = createDashboardModel({
    ...statusSnapshot(),
    readiness: { ready: true, blockers: [] },
    runner_health: { status: "ready", kind: "cli_app_server" }
  });
  const ready = createDashboardModel({
    ...statusSnapshot(),
    readiness: { ready: true, blockers: [] },
    runner_health: { status: "ready", kind: "cli_app_server" },
    active_runs: []
  });
  const blocked = createDashboardModel(statusSnapshot());

  assert.equal(running.state.label, "RUNNING");
  assert.equal(ready.state.label, "READY");
  assert.equal(blocked.state.label, "BLOCKED");
});

test("dashboard config discovery loads repo dotenv before config parsing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-dashboard-dotenv-"));
  const configDir = join(dir, ".fizzy-symphony");
  const registryDir = join(configDir, "run", "instances");
  const configPath = join(configDir, "config.json");
  await mkdir(registryDir, { recursive: true });
  await writeFile(join(dir, ".env"), "FIZZY_API_TOKEN=repo-token\n", "utf8");
  await writeFile(configPath, `${JSON.stringify({
    fizzy: { token: "$FIZZY_API_TOKEN" },
    server: { registry_dir: "run/instances", heartbeat_interval_ms: 1000 }
  })}\n`, "utf8");
  await writeFile(join(registryDir, "instance-b.json"), `${JSON.stringify({
    instance_id: "instance-b",
    pid: process.pid,
    endpoint: { base_url: "http://127.0.0.1:49171" },
    heartbeat_at: "2026-04-29T12:00:04.000Z"
  })}\n`, "utf8");

  const io = {
    ...ioCapture(),
    now: () => new Date("2026-04-29T12:00:05.000Z"),
    isPidAlive: () => true
  };
  const requested = [];

  const exitCode = await runDashboardCommand([
    "--config", configPath,
    "--instance", "instance-b",
    "--once",
    "--no-default-endpoint"
  ], io, {
    fetch: async (url) => {
      requested.push(url);
      return { ok: true, json: async () => statusSnapshot() };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requested, ["http://127.0.0.1:49171/status"]);
});

test("dashboard falls back to text when TUI setup fails after status succeeds", async () => {
  const io = ioCapture({ isTTY: true, env: { TERM: "xterm-256color" } });

  const exitCode = await runDashboardCommand(["--endpoint", "http://127.0.0.1:4567"], io, {
    fetch: async () => ({ ok: true, json: async () => statusSnapshot() }),
    createTerminalDashboard: async () => {
      throw new Error("terminal-kit missing");
    }
  });

  assert.equal(exitCode, 0);
  assert.match(io.stderr.text, /Dashboard TUI unavailable: terminal-kit missing/u);
  assert.doesNotMatch(io.stderr.text, /No live fizzy-symphony instance found/u);
  assert.match(io.stdout.text, /fizzy-symphony dashboard/u);
});

test("TTY dashboard refreshes status until the operator exits", async () => {
  const io = ioCapture({ isTTY: true, env: { TERM: "xterm-256color" } });
  const requested = [];
  const renders = [];
  const waited = [];
  const waitActions = ["refresh", "exit"];
  let closed = false;

  const exitCode = await runDashboardCommand([
    "--endpoint", "http://127.0.0.1:4567",
    "--refresh-ms", "25"
  ], io, {
    fetch: async (url) => {
      requested.push(url);
      return {
        ok: true,
        json: async () => ({
          ...statusSnapshot(),
          active_runs: Array.from({ length: requested.length }, (_, index) => ({ id: `run_${index}` }))
        })
      };
    },
    createTerminalDashboard: async () => ({
      render: async (model, options) => {
        renders.push({ activeRuns: model.counts.activeRuns, refreshMs: options.refreshMs });
      },
      waitForInput: async (refreshMs) => {
        waited.push(refreshMs);
        return waitActions.shift();
      },
      close: () => {
        closed = true;
      }
    })
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requested, [
    "http://127.0.0.1:4567/status",
    "http://127.0.0.1:4567/status"
  ]);
  assert.deepEqual(renders, [
    { activeRuns: 1, refreshMs: 25 },
    { activeRuns: 2, refreshMs: 25 }
  ]);
  assert.deepEqual(waited, [25, 25]);
  assert.equal(closed, true);
});

test("--once keeps TTY dashboard to one text status read", async () => {
  const io = ioCapture({ isTTY: true, env: { TERM: "xterm-256color" } });
  const requested = [];

  const exitCode = await runDashboardCommand([
    "--endpoint", "http://127.0.0.1:4567",
    "--once"
  ], io, {
    fetch: async (url) => {
      requested.push(url);
      return { ok: true, json: async () => statusSnapshot() };
    },
    createTerminalDashboard: async () => {
      throw new Error("TTY renderer should not run for --once");
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requested, ["http://127.0.0.1:4567/status"]);
  assert.match(io.stdout.text, /fizzy-symphony dashboard/u);
});

test("dashboard observes status without mutating workflow or dispatch state", async () => {
  const snapshot = statusSnapshot();
  const before = clone(snapshot);
  const requests = [];
  const io = ioCapture();

  const exitCode = await runDashboardCommand([
    "--endpoint", "http://127.0.0.1:4567",
    "--once"
  ], io, {
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => snapshot };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requests, [{ url: "http://127.0.0.1:4567/status", init: undefined }]);
  assert.deepEqual(snapshot, before);
});
