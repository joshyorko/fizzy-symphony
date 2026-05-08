import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { main as cliMain } from "../bin/fizzy-symphony.js";
import { createCompletionMarker } from "../src/completion.js";
import { startDaemon } from "../src/daemon.js";

test("CLI daemon reports config load errors as structured failures", async () => {
  const result = await runCli(["daemon", "--config", "/tmp/fizzy-symphony-missing-config.json"]);

  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stderr).code, "CONFIG_PARSE_ERROR");
});

test("CLI daemon defaults to the setup-generated YAML config path", async () => {
  const result = await runCli(["daemon"]);

  assert.equal(result.exitCode, 2);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, "CONFIG_PARSE_ERROR");
  assert.equal(error.details.path, ".fizzy-symphony/config.yml");
});

test("CLI start aliases daemon for the operator-facing command", async () => {
  const root = await tempProject("fizzy-symphony-start-cli-");
  const configPath = await writeConfig(root, { diagnostics: { no_dispatch: true } });

  const result = await runCli(["start", "--config", configPath], {
    env: { ...process.env, FIZZY_API_TOKEN: "token" },
    daemonOptions: {
      schedulerOptions: { immediate: false },
      dependencies: daemonDependencies({
        cards: [],
        runner: fakeRunner({ status: "unavailable", reason: "diagnostic runner missing" })
      })
    },
    async daemonStarted(daemon) {
      await daemon.stop("test");
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "start");
  assert.equal(payload.status, "running");
});

test("CLI start renders a real board snapshot for interactive terminals", async () => {
  const root = await tempProject("fizzy-symphony-start-live-board-");
  const configPath = await writeConfig(root, { diagnostics: { no_dispatch: true } });
  const board = boardFixture({
    columns: [
      { id: "col_ready", name: "Ready" },
      { id: "col_done", name: "Done" }
    ],
    cards: [
      {
        id: "golden_ready",
        title: "Ready Route",
        golden: true,
        column_id: "col_ready",
        tags: ["agent-instructions", "comment-once"]
      },
      {
        id: "card_42",
        number: 42,
        title: "Fix terminal output",
        column_id: "col_ready",
        tags: []
      }
    ]
  });

  const result = await runCli(["start", "--config", configPath], {
    stderrIsTTY: true,
    env: { ...process.env, CI: "", FIZZY_API_TOKEN: "token" },
    daemonOptions: {
      schedulerOptions: { immediate: false },
      dependencies: {
        ...daemonDependencies({
          cards: [],
          runner: fakeRunner({ status: "unavailable", reason: "diagnostic runner missing" })
        }),
        fizzyFactory: () => fakeFizzy({ board })
      }
    },
    async daemonStarted(daemon) {
      await daemon.stop("test");
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stderr, /Live board/u);
  assert.match(result.stderr, /#42 Fix terminal output/u);
});

test("CLI start warns when workspace protection skips a dirty source repo", async () => {
  const root = await tempProject("fizzy-symphony-start-dirty-source-");
  const configPath = await writeConfig(root);
  const calls = [];
  const dirtyError = Object.assign(new Error("source repo is dirty"), {
    code: "WORKSPACE_SOURCE_DIRTY",
    details: {
      preserve_workspace: true,
      source_repository_path: root,
      dirty_paths: ["README.md", "WORKFLOW.md", ".fizzy-symphony/config.yml"]
    }
  });

  const result = await runCli(["start", "--config", configPath], {
    env: { ...process.env, FIZZY_API_TOKEN: "token" },
    daemonOptions: {
      schedulerOptions: { immediate: false },
      dependencies: {
        ...daemonDependencies({
          calls,
          cards: [{ id: "card_1", number: 1, board_id: "board_1", column_id: "col_ready", title: "Ready" }]
        }),
        workspaceManagerFactory: () => ({
          async resolveIdentity() {
            calls.push("resolveWorkspace");
            return { workspace_key: "workspace_card_1", workspace_identity_digest: "sha256:workspace" };
          },
          async preflight() {
            calls.push("preflightWorkspace");
            throw dirtyError;
          }
        })
      }
    },
    async daemonStarted(daemon) {
      await daemon.scheduler.tickNow("test").catch(() => {});
      await daemon.stop("test");
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(calls.includes("preflightWorkspace"));
  const warning = result.stderr.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))[0];
  assert.equal(warning.level, "warn");
  assert.equal(warning.event, "workspace.source_dirty_protected");
  assert.equal(warning.code, "WORKSPACE_SOURCE_DIRTY");
  assert.equal(warning.message, "Source repository has local changes; preserving work and skipping dispatch.");
  assert.equal(warning.source_repository_path, root);
  assert.deepEqual(warning.dirty_paths, ["README.md", "WORKFLOW.md", ".fizzy-symphony/config.yml"]);
  assert.equal(warning.dirty_paths_count, 3);
});

test("CLI start renders workspace protection warnings for interactive terminals", async () => {
  const root = await tempProject("fizzy-symphony-start-dirty-source-tty-");
  const configPath = await writeConfig(root);
  const dirtyError = Object.assign(new Error("source repo is dirty"), {
    code: "WORKSPACE_SOURCE_DIRTY",
    details: {
      preserve_workspace: true,
      source_repository_path: root,
      dirty_paths: ["README.md", "WORKFLOW.md"]
    }
  });

  const result = await runCli(["start", "--config", configPath], {
    stderrIsTTY: true,
    env: { ...process.env, CI: "", FIZZY_API_TOKEN: "token" },
    daemonOptions: {
      schedulerOptions: { immediate: false },
      dependencies: {
        ...daemonDependencies({
          cards: [{ id: "card_1", number: 1, board_id: "board_1", column_id: "col_ready", title: "Ready" }]
        }),
        workspaceManagerFactory: () => ({
          async resolveIdentity() {
            return { workspace_key: "workspace_card_1", workspace_identity_digest: "sha256:workspace" };
          },
          async preflight() {
            throw dirtyError;
          }
        })
      }
    },
    async daemonStarted(daemon) {
      await daemon.scheduler.tickNow("test").catch(() => {});
      await daemon.stop("test");
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stderr, /fizzy-symphony watching boards/u);
  assert.match(result.stderr, /protecting your work/u);
  assert.match(result.stderr, /Ready -> comment_once/u);
  assert.match(result.stderr, /source repo has local changes, so this card was not dispatched/u);
  assert.match(result.stderr, /README\.md/u);
});

test("CLI daemon reports startup validation blockers and cleans the owned registry file", async () => {
  const root = await tempProject("fizzy-symphony-daemon-cli-blocked-");
  const configPath = await writeConfig(root, { workflow: { fallback_enabled: false, fallback_path: "" } });

  const result = await runCli(["daemon", "--config", configPath], {
    env: { ...process.env, FIZZY_API_TOKEN: "token" },
    daemonOptions: {
      dependencies: {
        fizzyFactory: () => fakeFizzy({
          board: boardFixture({
            cards: [{ id: "golden_1", golden: true, column_id: "col_ready", tags: ["agent-instructions"] }]
          })
        }),
        runnerFactory: () => fakeRunner()
      }
    }
  });

  assert.equal(result.exitCode, 2);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, "STARTUP_VALIDATION_FAILED");
  assert.deepEqual(error.details.errors.map((entry) => entry.code), ["MISSING_COMPLETION_POLICY"]);
  assert.deepEqual(await readDirOrEmpty(join(root, ".fizzy-symphony", "run", "instances")), []);
});

test("daemon no-dispatch mode starts, exposes degraded readiness, and does not claim or run work", async () => {
  const root = await tempProject("fizzy-symphony-daemon-no-dispatch-");
  const configPath = await writeConfig(root, { diagnostics: { no_dispatch: true } });
  const calls = [];

  const result = await runCli(["daemon", "--config", configPath], {
    env: { ...process.env, FIZZY_API_TOKEN: "token" },
    daemonOptions: {
      schedulerOptions: { immediate: false },
      dependencies: daemonDependencies({
        calls,
        cards: [{ id: "card_1", number: 1, board_id: "board_1", column_id: "col_ready", title: "Ready" }],
        runner: fakeRunner({ status: "unavailable", reason: "diagnostic runner missing" })
      })
    },
    async daemonStarted(daemon) {
      const health = await fetchJson(`${daemon.endpoint.base_url}/health`);
      const ready = await fetchJson(`${daemon.endpoint.base_url}/ready`);
      await daemon.scheduler.tickNow("test");
      await daemon.stop("test");

      assert.equal(health.response.status, 200);
      assert.equal(health.body.live, true);
      assert.equal(ready.response.status, 503);
      assert.equal(ready.body.blockers[0].code, "DISPATCH_DISABLED");
    }
  });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).status, "running");
  assert.ok(calls.includes("discover"));
  assert.equal(calls.includes("claim"), false);
  assert.equal(calls.includes("prepareWorkspace"), false);
  assert.equal(calls.includes("startSession"), false);
});

test("startDaemon wires startup, HTTP status, scheduler ticks, recovery, and status snapshots", async () => {
  const root = await tempProject("fizzy-symphony-daemon-start-");
  const configPath = await writeConfig(root);
  const calls = [];
  const daemon = await startDaemon({
    configPath,
    env: { ...process.env, FIZZY_API_TOKEN: "token" },
    schedulerOptions: { immediate: false },
    dependencies: daemonDependencies({
      calls,
      cards: [{ id: "card_1", number: 1, board_id: "board_1", column_id: "col_ready", title: "Ready" }]
    })
  });

  try {
    assert.equal(daemon.endpoint.host, "127.0.0.1");
    const health = await fetchJson(`${daemon.endpoint.base_url}/health`);
    const ready = await fetchJson(`${daemon.endpoint.base_url}/ready`);
    assert.equal(health.body.live, true);
    assert.equal(ready.body.ready, true);

    await daemon.scheduler.tickNow("test");
    const status = await fetchJson(`${daemon.endpoint.base_url}/status`);
    assert.deepEqual(status.body.routes.map((route) => route.id), ["board:board_1:column:col_ready:golden:golden_ready"]);
    assert.equal(status.body.runs.completed[0].card_id, "card_1");

    const snapshot = JSON.parse(await readFile(join(root, ".fizzy-symphony", "run", "status", "latest.json"), "utf8"));
    assert.equal(snapshot.instance.id, "instance-a");
    assert.equal(snapshot.runs.completed[0].card_id, "card_1");
    assert.ok(calls.includes("startupRecovery"));
  } finally {
    await daemon.stop("test");
  }
});

test("default daemon routing hydrates live comments and prevents comment_once loops", async () => {
  const root = await tempProject("fizzy-symphony-daemon-live-comments-");
  const configPath = await writeConfig(root);
  const calls = [];
  const card = { id: "card_1", number: 1, board_id: "board_1", column_id: "col_ready", title: "Already done" };
  let markerRoute;
  const daemon = await startDaemon({
    configPath,
    env: { ...process.env, FIZZY_API_TOKEN: "token" },
    schedulerOptions: { immediate: false },
    dependencies: {
      ...daemonDependencies({ calls, cards: [card] }),
      fizzyFactory: () => ({
        ...fakeFizzy(),
        async discoverCandidates() {
          calls.push("discover");
          return [card];
        },
        async listComments() {
          calls.push("listComments");
          const marker = createCompletionMarker({
            run: { id: "run_prior" },
            route: markerRoute,
            instance: { id: "instance-a" },
            workspace: { key: "workspace_prior", identity_digest: "sha256:workspace" },
            card,
            proof: { file: "/state/proof/run_prior.json", digest: "sha256:proof" },
            resultComment: { id: "comment_result" },
            completedAt: "2026-04-29T12:00:00.000Z"
          });
          return [{
            id: "comment_marker",
            body: { plain_text: marker.body, html: "<p>marker</p>" },
            created_at: "2026-04-29T12:00:00.000Z"
          }];
        }
      }),
      claimsFactory: () => ({
        async acquire() {
          calls.push("claim");
          throw new Error("claim must not run for a completed comment_once card");
        }
      })
    }
  });

  try {
    markerRoute = daemon.status.status().routes[0];
    await daemon.scheduler.tickNow("test");
    assert.ok(calls.includes("listComments"));
    assert.equal(calls.includes("claim"), false);
    assert.deepEqual(daemon.status.status().runs.running, []);
  } finally {
    await daemon.stop("test");
  }
});

test("default daemon workflow loader keeps last known good workflow after reload failure", async () => {
  const root = await tempProject("fizzy-symphony-daemon-workflow-cache-");
  const configPath = await writeConfig(root);
  const calls = [];
  let cards = [{ id: "card_1", number: 1, board_id: "board_1", column_id: "col_ready", title: "First" }];

  const daemon = await startDaemon({
    configPath,
    env: { ...process.env, FIZZY_API_TOKEN: "token" },
    schedulerOptions: { immediate: false },
    dependencies: {
      fizzyFactory: () => ({
        ...fakeFizzy(),
        async discoverCandidates() {
          calls.push("discover");
          return cards;
        },
        async postResultComment() {
          calls.push("postResult");
          return { id: `comment_${calls.filter((call) => call === "postResult").length}` };
        },
        async recordCompletionMarker() {
          calls.push("completionMarker");
          return { id: `marker_${calls.filter((call) => call === "completionMarker").length}` };
        }
      }),
      runnerFactory: () => ({
        ...fakeRunner({ calls }),
        async startSession(workspacePath, { workflow }) {
          calls.push(`startSession:${workflow.body}`);
          return { session_id: `session_${calls.filter((call) => call.startsWith("startSession")).length}`, workspace: workspacePath };
        }
      }),
      claimsFactory: () => ({
        async acquire({ card }) {
          calls.push(`claim:${card.id}`);
          return {
            acquired: true,
            claim: {
              id: `claim_${card.id}`,
              claim_id: `claim_${card.id}`,
              run_id: `run_${card.id}`,
              attempt_id: `attempt_${card.id}`
            }
          };
        },
        async release({ status }) {
          calls.push(`releaseClaim:${status}`);
          return { released: true };
        }
      }),
      workspaceManagerFactory: () => ({
        async resolveIdentity({ card }) {
          return { workspace_key: `workspace_${card.id}`, workspace_identity_digest: `sha256:${card.id}` };
        },
        async prepare({ card }) {
          calls.push(`prepareWorkspace:${card.id}`);
          return {
            key: `workspace_${card.id}`,
            sourceRepo: root,
            path: join(root, ".fizzy-symphony", "workspaces", card.id),
            identity_digest: `sha256:${card.id}`
          };
        }
      }),
      recoveryFactory: () => async (options) => {
        calls.push("startupRecovery");
        options.status?.recordStartupRecovery?.({ warnings: [], errors: [] });
        return { warnings: [], errors: [] };
      }
    }
  });

  try {
    await daemon.scheduler.tickNow("first");
    await writeFile(join(root, "WORKFLOW.md"), "---\nname\n---\nBroken\n", "utf8");
    cards = [{ id: "card_2", number: 2, board_id: "board_1", column_id: "col_ready", title: "Second" }];
    await daemon.scheduler.tickNow("second");

    const snapshot = daemon.status.status();
    assert.deepEqual(snapshot.runs.completed.map((run) => run.card_id), ["card_1", "card_2"]);
    assert.deepEqual(
      calls.filter((call) => call.startsWith("startSession:")),
      ["startSession:# Workflow", "startSession:# Workflow"]
    );
    assert.equal(snapshot.workflow_cache.recent_reload_errors[0].code, "WORKFLOW_FRONT_MATTER_INVALID");
    assert.equal(snapshot.workflow_cache.recent_reload_errors[0].cache_hit, true);
  } finally {
    await daemon.stop("test");
  }
});

test("daemon webhooks enqueue through the scheduler and trigger reconciliation", async () => {
  const root = await tempProject("fizzy-symphony-daemon-webhook-");
  const configPath = await writeConfig(root);
  const calls = [];
  const seenHints = [];
  const daemon = await startDaemon({
    configPath,
    env: { ...process.env, FIZZY_API_TOKEN: "token" },
    schedulerOptions: { immediate: false },
    dependencies: {
      ...daemonDependencies({ calls }),
      fizzyFactory: () => ({
        ...fakeFizzy(),
        async discoverCandidates({ hints }) {
          calls.push("discover");
          seenHints.push(hints);
          return [];
        },
        async refreshActiveCards() {
          calls.push("refreshActiveCards");
          return [];
        }
      })
    }
  });

  try {
    const response = await fetchJson(`${daemon.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "event_1",
        action: "card_triaged",
        card: { id: "card_1", board_id: "board_1" }
      })
    });

    assert.equal(response.response.status, 202);
    await waitFor(() => calls.includes("discover"));
    assert.deepEqual(seenHints[0], [{
      event_id: "event_1",
      card_id: "card_1",
      board_id: "board_1",
      action: "card_triaged",
      intent: "spawn"
    }]);
    assert.equal(calls.includes("startSession"), false);
  } finally {
    await daemon.stop("test");
  }
});

test("daemon periodically refreshes runner health without dispatching or mutating Fizzy state", async () => {
  const root = await tempProject("fizzy-symphony-daemon-runner-health-");
  const configPath = await writeConfig(root, {
    polling: { interval_ms: 30000, use_etags: true, use_api_filters: true },
    runner: { health: { enabled: true, interval_ms: 25 } }
  });
  const calls = [];
  const timers = createManualTimers();
  const daemon = await startDaemon({
    configPath,
    env: { ...process.env, FIZZY_API_TOKEN: "token" },
    schedulerOptions: { immediate: false, timers },
    dependencies: daemonDependencies({
      calls,
      cards: [{ id: "card_1", number: 1, board_id: "board_1", column_id: "col_ready", title: "Ready" }],
      runner: fakeRunner({
        calls,
        healthReports: [
          { status: "ready", kind: "cli_app_server", checked_at: "2026-04-29T12:00:00.000Z" },
          { status: "unavailable", kind: "cli_app_server", reason: "app server exited" },
          { status: "ready", kind: "cli_app_server", checked_at: "2026-04-29T12:01:00.000Z" }
        ]
      })
    })
  });

  try {
    assert.equal(daemon.status.ready().ready, true);
    calls.length = 0;

    await timers.runNext(25);
    assert.deepEqual(calls, ["health"]);
    assert.equal(daemon.status.ready().ready, false);
    assert.equal(daemon.status.ready().blockers[0].code, "RUNNER_NOT_READY");
    assert.equal(daemon.status.status().runner_health.reason, "app server exited");

    calls.length = 0;
    await timers.runNext(25);
    assert.deepEqual(calls, ["health"]);
    assert.equal(daemon.status.ready().ready, true);
    assert.equal(daemon.status.status().runs.running.length, 0);
    assert.equal(calls.includes("discover"), false);
    assert.equal(calls.includes("claim"), false);
    assert.equal(calls.includes("startSession"), false);
  } finally {
    await daemon.stop("test");
  }
});

test("SIGTERM shutdown stops scheduling, cancels active work, preserves workspace, closes server, and removes own registry", async () => {
  const root = await tempProject("fizzy-symphony-daemon-signal-");
  const configPath = await writeConfig(root);
  const signalProcess = new EventEmitter();
  signalProcess.pid = 12345;
  const calls = [];
  let releaseStream;
  const streamGate = new Promise((resolve) => {
    releaseStream = resolve;
  });
  const daemon = await startDaemon({
    configPath,
    env: { ...process.env, FIZZY_API_TOKEN: "token" },
    signalProcess,
    schedulerOptions: { immediate: false },
      dependencies: daemonDependencies({
      calls,
      cards: [{ id: "card_1", number: 1, board_id: "board_1", column_id: "col_ready", title: "Ready" }],
      runner: fakeRunner({ streamGate, calls })
    })
  });

  const tick = daemon.scheduler.tickNow("test");
  try {
    await waitFor(() => calls.includes("stream"));
    signalProcess.emit("SIGTERM", "SIGTERM");
    await daemon.stopped;
    releaseStream();
    await tick;

    const snapshot = daemon.status.status();
    assert.equal(snapshot.runs.cancelled[0].card_id, "card_1");
    assert.equal(snapshot.runs.cancelled[0].cancellation_reason, "shutdown");
    assert.equal(snapshot.shutdown.reason, "signal:SIGTERM");
    assert.ok(calls.includes("cancel"));
    assert.ok(calls.includes("releaseClaim:cancelled"));
    assert.ok(calls.includes("preserveWorkspace"));
    assert.deepEqual(await readDirOrEmpty(join(root, ".fizzy-symphony", "run", "instances")), []);

    await assert.rejects(
      () => fetch(`${daemon.endpoint.base_url}/health`),
      (error) => error.name === "TypeError" || error.code === "ECONNREFUSED"
    );
  } finally {
    releaseStream();
    await tick.catch(() => {});
    await daemon.stop("test-cleanup").catch(() => {});
  }
});

test("shutdown escalates from failed runner cancel to session stop", async () => {
  const root = await tempProject("fizzy-symphony-daemon-shutdown-escalation-");
  const configPath = await writeConfig(root);
  const signalProcess = new EventEmitter();
  signalProcess.pid = 12346;
  const calls = [];
  let releaseStream;
  const streamGate = new Promise((resolve) => {
    releaseStream = resolve;
  });
  const daemon = await startDaemon({
    configPath,
    env: { ...process.env, FIZZY_API_TOKEN: "token" },
    signalProcess,
    schedulerOptions: { immediate: false },
    dependencies: daemonDependencies({
      calls,
      cards: [{ id: "card_1", number: 1, board_id: "board_1", column_id: "col_ready", title: "Ready" }],
      runner: fakeRunner({
        streamGate,
        calls,
        cancelResult: { status: "failed", success: false }
      })
    })
  });

  const tick = daemon.scheduler.tickNow("test");
  try {
    await waitFor(() => calls.includes("stream"));
    signalProcess.emit("SIGTERM", "SIGTERM");
    await daemon.stopped;
    releaseStream();
    await tick;

    const cancellation = daemon.status.status().runs.cancelled[0].cancellation;
    assert.equal(cancellation.states.runner_cancel_sent.status, "failed");
    assert.equal(cancellation.states.session_stopped.status, "succeeded");
    assert.ok(calls.includes("stopSession"));
  } finally {
    releaseStream();
    await tick.catch(() => {});
    await daemon.stop("test-cleanup").catch(() => {});
  }
});

function daemonDependencies({ calls, cards = [], runner = fakeRunner() } = {}) {
  return {
    fizzyFactory: () => ({
      ...fakeFizzy(),
      async discoverCandidates() {
        calls?.push("discover");
        return cards;
      },
      async refreshActiveCards() {
        calls?.push("refreshActiveCards");
        return cards;
      },
      async postResultComment() {
        calls?.push("postResult");
        return { id: "comment_1" };
      },
      async recordCompletionMarker() {
        calls?.push("completionMarker");
        return { id: "marker_1" };
      }
    }),
    runnerFactory: () => runner,
    claimsFactory: () => ({
      async acquire({ card }) {
        calls?.push("claim");
        return {
          acquired: true,
          claim: {
            id: `claim_${card.id}`,
            claim_id: `claim_${card.id}`,
            run_id: `run_${card.id}`,
            attempt_id: `attempt_${card.id}`
          }
        };
      },
      async release({ status }) {
        calls?.push(`releaseClaim:${status}`);
        return { released: true };
      }
    }),
    workspaceManagerFactory: () => ({
      async resolveIdentity() {
        calls?.push("resolveWorkspace");
        return { workspace_key: "workspace_card_1", workspace_identity_digest: "sha256:workspace" };
      },
      async prepare() {
        calls?.push("prepareWorkspace");
        return { key: "workspace_card_1", path: "/tmp/workspace-card-1", identity_digest: "sha256:workspace" };
      },
      async preserve() {
        calls?.push("preserveWorkspace");
        return { status: "preserved", workspace_path: "/tmp/workspace-card-1" };
      }
    }),
    workflowLoaderFactory: () => ({
      async load() {
        calls?.push("loadWorkflow");
        return { body: "Do the work", front_matter: {} };
      }
    }),
    recoveryFactory: () => async (options) => {
      calls?.push("startupRecovery");
      options.status?.recordStartupRecovery?.({ warnings: [], errors: [] });
      return { warnings: [], errors: [] };
    }
  };
}

function fakeRunner(options = {}) {
  const healthReports = [...(options.healthReports ?? [])];
  return {
    async detect() {
      return { kind: "cli_app_server", available: true };
    },
    async validate() {
      return { ok: true, kind: "cli_app_server" };
    },
    async health() {
      options.calls?.push("health");
      if (healthReports.length > 0) return healthReports.shift();
      return options.status
        ? { status: options.status, reason: options.reason, kind: "cli_app_server" }
        : { status: "ready", kind: "cli_app_server" };
    },
    async startSession() {
      options.calls?.push("startSession");
      return { session_id: "session_1", process_owned: true };
    },
    async startTurn(session) {
      return { turn_id: "turn_1", session_id: session.session_id };
    },
    async stream(turn, onEvent) {
      options.calls?.push("stream");
      onEvent?.({ type: "turn.started", turn_id: turn.turn_id });
      if (options.streamGate) await options.streamGate;
      return { status: "completed", turn_id: turn.turn_id, no_code_change: true };
    },
    async cancel() {
      options.calls?.push("cancel");
      return options.cancelResult ?? { status: "cancelled", success: true };
    },
    async stopSession() {
      options.calls?.push("stopSession");
      return { status: "stopped", success: true };
    }
  };
}

function createManualTimers() {
  const handles = [];
  return {
    setTimeout(callback, delay) {
      const handle = {
        delay,
        callback,
        cleared: false,
        unref() {}
      };
      handles.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) handle.cleared = true;
    },
    async runNext(delay) {
      const handle = handles.find((candidate) => !candidate.cleared && candidate.delay === delay);
      assert.ok(handle, `expected scheduled timer with delay ${delay}`);
      handle.cleared = true;
      await handle.callback();
    }
  };
}

function fakeFizzy(options = {}) {
  const board = options.board ?? boardFixture();
  return {
    async getIdentity() {
      return { user: { id: "user_1" } };
    },
    async listUsers() {
      return [{ id: "bot_1" }];
    },
    async listTags() {
      return [
        { id: "tag_agent", name: "agent-instructions" },
        { id: "tag_comment", name: "comment-once" }
      ];
    },
    async getEntropy() {
      return { warnings: [] };
    },
    async getBoard() {
      return board;
    }
  };
}

function boardFixture(overrides = {}) {
  return {
    id: "board_1",
    name: "Agents",
    columns: [{ id: "col_ready", name: "Ready" }],
    cards: [{
      id: "golden_ready",
      title: "Ready Route",
      golden: true,
      column_id: "col_ready",
      tags: ["agent-instructions", "comment-once"]
    }],
    ...overrides
  };
}

async function writeConfig(root, overrides = {}) {
  await writeFile(join(root, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const config = mergeConfig(baseConfig(root), overrides);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify(config), "utf8");
  return configPath;
}

function baseConfig(root) {
  return {
    instance: { id: "instance-a", label: "local" },
    fizzy: {
      token: "$FIZZY_API_TOKEN",
      account: "acct",
      api_url: "https://app.fizzy.do",
      bot_user_id: ""
    },
    boards: {
      entries: [{
        id: "board_1",
        label: "Agents",
        enabled: true,
        routing_mode: "column_scoped",
        defaults: {
          backend: "codex",
          model: "",
          workspace: "app",
          persona: "repo-agent",
          unknown_managed_tag_policy: "fail",
          allowed_card_overrides: {
            backend: false,
            model: false,
            workspace: false,
            persona: false,
            priority: true,
            completion: false
          },
          concurrency: { max_concurrent: 1 }
        }
      }]
    },
    server: {
      host: "127.0.0.1",
      port: "auto",
      port_allocation: "random",
      base_port: 4567,
      registry_dir: join(root, ".fizzy-symphony", "run", "instances"),
      heartbeat_interval_ms: 5000
    },
    webhook: {
      enabled: true,
      path: "/webhook",
      secret: "",
      manage: false,
      managed_webhook_ids_by_board: {},
      callback_url: "",
      subscribed_actions: ["comment_created"]
    },
    polling: { interval_ms: 30000, use_etags: true, use_api_filters: true },
    agent: {
      max_concurrent: 1,
      max_concurrent_per_card: 1,
      turn_timeout_ms: 3600000,
      stall_timeout_ms: 300000,
      max_turns: 1,
      max_retry_backoff_ms: 300000,
      default_backend: "codex",
      default_model: "",
      default_persona: "repo-agent"
    },
    runner: {
      preferred: "cli_app_server",
      fallback: "cli_app_server",
      allow_fallback: true,
      sdk: { package: "", contract: "", smoke_test: false },
      cli_app_server: { command: "codex", args: ["app-server"] },
      health: { enabled: true, interval_ms: 60000 },
      codex: {
        approval_policy: {
          mode: "reject",
          sandbox_approval: "reject",
          command_approval: "reject",
          tool_approval: "reject",
          mcp_elicitation: "reject"
        },
        interactive: false,
        thread_sandbox: "workspace-write",
        turn_sandbox_policy: { type: "workspaceWrite" }
      }
    },
    workspaces: {
      root: join(root, ".fizzy-symphony", "workspaces"),
      metadata_root: join(root, ".fizzy-symphony", "run", "workspaces"),
      default_isolation: "git_worktree",
      default_repo: root,
      registry: {
        app: {
          repo: root,
          isolation: "git_worktree",
          base_ref: "main",
          worktree_root: join(root, ".fizzy-symphony", "worktrees"),
          branch_prefix: "fizzy",
          workflow_path: "WORKFLOW.md",
          require_clean_source: true
        }
      },
      retry: { workspace_policy: "reuse" }
    },
    workflow: { create_starter_on_setup: false, fallback_enabled: false, fallback_path: "" },
    routing: { allow_postponed_cards: false, rerun: { mode: "explicit_tag_only", agent_rerun_consumption: "remove_when_supported" } },
    diagnostics: { no_dispatch: false },
    claims: {
      mode: "structured_comment",
      tag_visibility: false,
      tag: "agent-claimed",
      assign_on_claim: false,
      watch_on_claim: false,
      lease_ms: 900000,
      renew_interval_ms: 300000,
      steal_grace_ms: 30000,
      max_clock_skew_ms: 30000
    },
    completion: {
      allow_card_completion_override: false,
      markers: {
        mode: "structured_comment_and_tag",
        success_tag_prefix: "agent-completed",
        failure_tag_prefix: "agent-completion-failed"
      }
    },
    workpad: { enabled: false, mode: "single_comment", update_interval_ms: 30000 },
    safety: {
      allowed_roots: [root, join(root, ".fizzy-symphony")],
      dirty_source_repo_policy: "fail",
      cleanup: {
        policy: "preserve",
        require_proof_before_cleanup: true,
        require_handoff_before_cleanup: true,
        forbid_force_remove: true,
        retention_ms: 604800000
      }
    },
    observability: {
      state_dir: join(root, ".fizzy-symphony", "run"),
      log_dir: join(root, ".fizzy-symphony", "logs"),
      status_snapshot_path: join(root, ".fizzy-symphony", "run", "status", "latest.json"),
      status_retention_ms: 604800000,
      log_format: "json"
    }
  };
}

function mergeConfig(base, overrides) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object") {
      base[key] = mergeConfig({ ...base[key] }, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

async function runCli(args, options = {}) {
  let stdout = "";
  let stderr = "";
  const stderrWriter = {
    write: (chunk) => { stderr += chunk; },
    isTTY: Boolean(options.stderrIsTTY)
  };
  const exitCode = await cliMain(args, {
    env: options.env ?? process.env,
    daemonOptions: options.daemonOptions,
    daemonStarted: options.daemonStarted,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: stderrWriter
  });
  return { exitCode, stdout, stderr };
}

async function tempProject(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function readDirOrEmpty(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for predicate");
}
