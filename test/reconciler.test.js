import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createBoardClaimStore } from "../src/claims.js";
import { runReconciliationTick } from "../src/reconciler.js";
import { createOrchestratorState } from "../src/orchestrator-state.js";
import { createStatusStore } from "../src/status.js";
import { parseCompletionFailureMarker, parseCompletionMarker } from "../src/completion.js";
import { createCachedWorkflowLoader } from "../src/workflow.js";

const START = Date.parse("2026-04-29T12:00:00.000Z");

function configFixture(maxConcurrent = 2) {
  return {
    instance: { id: "instance-a", label: "local" },
    boards: { entries: [{ id: "board_1", label: "Agents", enabled: true }] },
    polling: { interval_ms: 30000 },
    webhook: { enabled: false },
    agent: { max_concurrent: maxConcurrent, max_turns: 1 },
    runner: { preferred: "cli_app_server" },
    observability: {}
  };
}

function statusStore(config = configFixture()) {
  const store = createStatusStore({
    instance: { id: "instance-a", label: "local" },
    startedAt: "2026-04-29T12:00:00.000Z",
    config
  });
  store.updateRunnerHealth({ status: "ready", kind: "cli_app_server" });
  return store;
}

function routeFixture() {
  return {
    id: "board:board_1:column:col_ready:golden:golden_1",
    board_id: "board_1",
    source_column_id: "col_ready",
    fingerprint: "sha256:route",
    workspace: "app",
    completion: { policy: "comment_once" }
  };
}

function cardFixture(id = "card_1", number = 1) {
  return {
    id,
    number,
    board_id: "board_1",
    column_id: "col_ready",
    title: `Card ${number}`,
    tags: []
  };
}

function fixedNow() {
  return new Date("2026-04-29T12:02:00.000Z");
}

function clockFixture() {
  let time = START;
  return {
    now() {
      return new Date(time);
    },
    advance(ms) {
      time += ms;
      return new Date(time);
    }
  };
}

function schedulerFixture() {
  let nextId = 1;
  const timers = new Map();

  return {
    setTimeout(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, callback, delayMs, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.cleared = true;
    },
    pending() {
      return [...timers.values()].filter((timer) => !timer.cleared);
    },
    async fire(id) {
      const timer = timers.get(id);
      assert.ok(timer, `expected timer ${id} to exist`);
      return timer.callback();
    }
  };
}

function successfulDependencies({ calls, cards, route }) {
  return {
    fizzy: {
      async discoverCandidates({ hints }) {
        calls.push("discover");
        assert.deepEqual(hints, []);
        return cards;
      },
      async postResultComment({ proof }) {
        calls.push("postResult");
        assert.match(proof.file, /proof\/run_card_1\.json$/u);
        return { id: "comment_1" };
      },
      async recordCompletionMarker({ resultComment, proof, payload, body }) {
        calls.push("completionMarker");
        assert.equal(resultComment.id, "comment_1");
        assert.equal(payload.proof_digest, proof.digest);
        assert.equal(parseCompletionMarker(body).proof_digest, proof.digest);
        return { id: "marker_1", status: "recorded" };
      }
    },
    router: {
      async validateCandidate({ card }) {
        calls.push("route");
        return { action: "spawn", card, route, prompt: "Do the safe fake turn." };
      }
    },
    claims: {
      async acquire({ card }) {
        calls.push("claim");
        return {
          acquired: true,
          claim: {
            id: `claim_${card.id}`,
            run_id: `run_${card.id}`,
            attempt_id: `attempt_${card.id}`
          }
        };
      },
      async release({ status }) {
        calls.push("releaseClaim");
        assert.equal(status, "completed");
        return { released: true };
      }
    },
    workspaceManager: {
      async prepare({ claim }) {
        calls.push("prepareWorkspace");
        return {
          key: `workspace_${claim.run_id}`,
          path: `/tmp/${claim.run_id}`,
          identity_digest: "sha256:workspace"
        };
      }
    },
    workflowLoader: {
      async load({ workspace }) {
        calls.push("loadWorkflow");
        return { body: `Workflow for ${workspace.key}`, front_matter: {} };
      }
    },
    runner: {
      async startSession(workspacePath) {
        calls.push("startSession");
        return { session_id: "session_1", workspace: workspacePath };
      },
      async startTurn(session, prompt) {
        calls.push("startTurn");
        assert.equal(prompt, "Do the safe fake turn.");
        return { turn_id: "turn_1", session_id: session.session_id, prompt };
      },
      async stream(turn, onEvent) {
        calls.push("stream");
        onEvent?.({ type: "turn.completed", session_id: turn.session_id, turn_id: turn.turn_id });
        return {
          type: "TurnResult",
          status: "completed",
          session_id: turn.session_id,
          turn_id: turn.turn_id,
          output_summary: "ok",
          no_code_change: true
        };
      },
      async stopSession(session) {
        calls.push("stopSession");
        assert.equal(session.session_id, "session_1");
        return { status: "stopped", success: true };
      }
    }
  };
}

function loggerFixture(events) {
  return {
    info(event, fields) {
      events.push({ level: "info", event, fields });
    },
    warn(event, fields) {
      events.push({ level: "warn", event, fields });
    },
    error(event, fields) {
      events.push({ level: "error", event, fields });
    },
    child() {
      return this;
    }
  };
}

test("runReconciliationTick proves the fake vertical slice order from discovery through completion status", async () => {
  const calls = [];
  const config = {
    ...configFixture(2),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-proof-")) }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const deps = successfulDependencies({ calls, cards: [card], route });

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    ...deps
  });

  assert.deepEqual(calls, [
    "discover",
    "route",
    "claim",
    "prepareWorkspace",
    "loadWorkflow",
    "startSession",
    "startTurn",
    "stream",
    "postResult",
    "completionMarker",
    "stopSession",
    "releaseClaim"
  ]);
  assert.equal(result.dispatched, 1);
  assert.equal(result.completed, 1);

  const snapshot = status.status();
  assert.deepEqual(snapshot.runs.completed.map((run) => run.id), ["run_card_1"]);
  assert.match(snapshot.runs.completed[0].proof.digest, /^sha256:/u);
  assert.equal(snapshot.runs.completed[0].result_comment_id, "comment_1");
  assert.equal(snapshot.runs.completed[0].completion_marker.id, "marker_1");
  assert.equal(snapshot.poll.last_completed_at, "2026-04-29T12:02:00.000Z");
});

test("runReconciliationTick logs live card progress for start terminals", async () => {
  const calls = [];
  const events = [];
  const config = {
    ...configFixture(2),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-live-log-")) }
  };
  const status = statusStore(config);
  const route = {
    ...routeFixture(),
    source_column_name: "Ready for Agents",
    completion: { policy: "move_to_column", target_column_id: "col_done", target_column_name: "Done" }
  };
  const card = { ...cardFixture("card_1", 42), title: "Fix terminal output" };
  const deps = successfulDependencies({ calls, cards: [card], route });
  deps.fizzy.moveCardToColumn = async ({ column_id }) => {
    calls.push("moveCardToColumn");
    assert.equal(column_id, "col_done");
    return { ok: true };
  };

  await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    logger: loggerFixture(events),
    ...deps
  });

  assert.deepEqual(events.map((event) => event.event), [
    "card.dispatch_started",
    "card.workspace_prepared",
    "card.runner_started",
    "card.runner_completed",
    "card.dispatch_completed"
  ]);
  assert.match(events[0].fields.message, /#42 Fix terminal output/u);
  assert.match(events.at(-1).fields.message, /Done/u);
});

test("runReconciliationTick renders full Fizzy card context for normal dispatch prompts", async () => {
  const calls = [];
  const prompts = [];
  const config = {
    ...configFixture(1),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-prompt-")) }
  };
  const status = statusStore(config);
  const route = {
    ...routeFixture(),
    source_column_name: "Ready for Agents",
    model: "gpt-5.1",
    persona: "repo-agent",
    completion: { policy: "comment_once" }
  };
  const card = {
    ...cardFixture("card_1", 1),
    title: "Implement live daemon foundation",
    body: "Wire real daemon dependencies and prompt context.",
    steps: [{ title: "Run npm test", completed: false }],
    comments: [{ author: { name: "Josh" }, body: "Use the golden ticket first." }],
    tags: ["priority-1"],
    url: "https://fizzy.example/cards/1"
  };
  const deps = successfulDependencies({ calls, cards: [card], route });
  deps.fizzy.postWorkpadComment = async ({ body }) => {
    calls.push("postWorkpad");
    assert.match(body, /fizzy-symphony:workpad:v1/u);
    return { id: "workpad_1" };
  };

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    fizzy: deps.fizzy,
    router: {
      async validateCandidate({ card: routedCard }) {
        calls.push("route");
        return { action: "spawn", card: routedCard, route };
      }
    },
    claims: deps.claims,
    workspaceManager: deps.workspaceManager,
    workflowLoader: {
      async load() {
        calls.push("loadWorkflow");
        return {
          body: "Follow repo workflow for {{card.title}}.",
          frontMatter: {
            owner: "repo-policy",
            completion: { required_steps_block_completion: true }
          }
        };
      }
    },
    runner: {
      ...deps.runner,
      async startTurn(session, prompt, metadata) {
        calls.push("startTurn");
        prompts.push(prompt);
        assert.equal(metadata.card_id, "card_1");
        return { turn_id: "turn_1", session_id: session.session_id, prompt };
      }
    }
  });

  assert.equal(result.completed, 1);
  assert.match(prompts[0], /Workflow front matter/u);
  assert.match(prompts[0], /"owner": "repo-policy"/u);
  assert.match(prompts[0], /Follow repo workflow for Implement live daemon foundation\./u);
  assert.match(prompts[0], /Fizzy task context/u);
  assert.match(prompts[0], /Golden-ticket route:/u);
  assert.match(prompts[0], /Work card:/u);
  assert.match(prompts[0], /Wire real daemon dependencies and prompt context\./u);
  assert.match(prompts[0], /- \[ \] Run npm test/u);
  assert.match(prompts[0], /Josh: Use the golden ticket first\./u);
  assert.match(prompts[0], /Active workpad/u);
  assert.match(prompts[0], /"comment_id": "workpad_1"/u);
  assert.match(prompts[0], /Completion policy:/u);
  assert.match(prompts[0], /"policy": "comment_once"/u);
});

test("runReconciliationTick continues on the same runner session when a completed turn requests another turn", async () => {
  const calls = [];
  const prompts = [];
  const sessions = [];
  const config = {
    ...configFixture(1),
    agent: { ...configFixture(1).agent, max_turns: 3 },
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-continuation-")) }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const deps = successfulDependencies({ calls, cards: [card], route });

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    ...deps,
    runner: {
      async startSession(workspacePath) {
        calls.push("startSession");
        return { session_id: "session_1", workspace: workspacePath };
      },
      async startTurn(session, prompt) {
        calls.push("startTurn");
        sessions.push(session.session_id);
        prompts.push(prompt);
        return { turn_id: `turn_${prompts.length}`, session_id: session.session_id, prompt };
      },
      async stream(turn) {
        calls.push("stream");
        if (turn.turn_id === "turn_1") {
          return {
            type: "TurnResult",
            status: "completed",
            session_id: turn.session_id,
            turn_id: turn.turn_id,
            continue: true,
            next_prompt: "Continue this same Fizzy card."
          };
        }
        return {
          type: "TurnResult",
          status: "completed",
          session_id: turn.session_id,
          turn_id: turn.turn_id,
          output_summary: "done",
          no_code_change: true
        };
      },
      async stopSession(session) {
        calls.push("stopSession");
        return { status: "stopped", success: true, session_id: session.session_id };
      }
    }
  });

  assert.equal(result.completed, 1);
  assert.deepEqual(calls.filter((call) => call === "startSession"), ["startSession"]);
  assert.deepEqual(calls.filter((call) => call === "startTurn"), ["startTurn", "startTurn"]);
  assert.deepEqual(sessions, ["session_1", "session_1"]);
  assert.equal(prompts[1], "Continue this same Fizzy card.");
  assert.equal(status.status().runs.completed[0].runner_result.turn_results.length, 2);
});

test("runReconciliationTick fails instead of completing when max_turns is exhausted with continuation pending", async () => {
  const calls = [];
  const config = {
    ...configFixture(1),
    agent: { ...configFixture(1).agent, max_turns: 1 },
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-max-turns-")) }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const deps = successfulDependencies({ calls, cards: [card], route });
  deps.claims.release = async ({ status }) => {
    calls.push("releaseClaim");
    assert.equal(status, "failed");
    return { released: true };
  };

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    ...deps,
    runner: {
      ...deps.runner,
      async stream(turn) {
        calls.push("stream");
        return {
          type: "TurnResult",
          status: "completed",
          session_id: turn.session_id,
          turn_id: turn.turn_id,
          continue: true,
          next_prompt: "Still needs more work."
        };
      }
    }
  });

  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.equal(status.status().runs.failed[0].last_error.code, "RUNNER_MAX_TURNS_REACHED");
  assert.equal(calls.includes("postResult"), false);
});

test("runReconciliationTick terminates owned app-server process when successful stop does not close", async () => {
  const calls = [];
  const config = {
    ...configFixture(1),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-stop-")) }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const deps = successfulDependencies({ calls, cards: [card], route });
  deps.runner.startSession = async (workspacePath) => {
    calls.push("startSession");
    return { session_id: "session_1", workspace: workspacePath, process_owned: true };
  };
  deps.runner.stopSession = async () => {
    calls.push("stopSession");
    return { status: "failed", success: false, close_result: { status: "closing" } };
  };
  deps.runner.terminateOwnedProcess = async () => {
    calls.push("terminateOwnedProcess");
    return { status: "terminated", success: true, signal: "SIGTERM" };
  };

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    ...deps
  });

  assert.equal(result.completed, 1);
  assert.ok(calls.includes("stopSession"));
  assert.ok(calls.includes("terminateOwnedProcess"));
  const completed = status.status().runs.completed[0];
  assert.equal(completed.runner_session_finalization.states.session_stopped.status, "failed");
  assert.equal(completed.runner_session_finalization.states.process_terminated.status, "succeeded");
});

test("runReconciliationTick runs after_run workspace hook before completion side effects", async () => {
  const calls = [];
  const config = {
    ...configFixture(1),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-after-run-")) }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const deps = successfulDependencies({ calls, cards: [card], route });

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    ...deps,
    fizzy: {
      ...deps.fizzy,
      async postResultComment(context) {
        assert.ok(calls.includes("afterRun"));
        return deps.fizzy.postResultComment(context);
      }
    },
    workspaceManager: {
      ...deps.workspaceManager,
      async afterRun({ result, turn_results }) {
        calls.push("afterRun");
        assert.equal(result.status, "completed");
        assert.equal(turn_results.length, 1);
        return { status: "ok" };
      }
    }
  });

  assert.equal(result.completed, 1);
  assert.ok(calls.indexOf("afterRun") < calls.indexOf("postResult"));
});

test("runReconciliationTick runs workflow hooks.after_run when no workspace manager hook is injected", async () => {
  const calls = [];
  const workspacePath = await mkdtemp(join(tmpdir(), "fizzy-symphony-after-run-workflow-"));
  await writeFile(
    join(workspacePath, "hook.js"),
    "import { appendFileSync } from 'node:fs';\nappendFileSync('hook.log', `${process.argv[2]}\\n`);\n",
    "utf8"
  );
  const config = {
    ...configFixture(1),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-after-run-workflow-")) }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const deps = successfulDependencies({ calls, cards: [card], route });

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    ...deps,
    fizzy: {
      ...deps.fizzy,
      async postResultComment(context) {
        assert.equal(await readFile(join(workspacePath, "hook.log"), "utf8"), "after_run\n");
        return deps.fizzy.postResultComment(context);
      }
    },
    workspaceManager: {
      async prepare() {
        calls.push("prepareWorkspace");
        return { key: "workspace_card_1", path: workspacePath, identity_digest: "sha256:workspace" };
      }
    },
    workflowLoader: {
      async load() {
        calls.push("loadWorkflow");
        return {
          body: "Workflow with after_run.",
          front_matter: {
            hooks: {
              after_run: {
                command: "node",
                args: ["hook.js", "after_run"]
              }
            }
          }
        };
      }
    }
  });

  assert.equal(result.completed, 1);
});

test("long-running streams renew active claims before another daemon can steal them", async () => {
  const calls = [];
  const comments = [];
  const clock = clockFixture();
  const scheduler = schedulerFixture();
  const stateDir = await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-renew-"));
  const config = {
    ...configFixture(1),
    claims: {
      mode: "structured_comment",
      lease_ms: 1000,
      renew_interval_ms: 500,
      steal_grace_ms: 0,
      max_clock_skew_ms: 0
    },
    observability: { state_dir: stateDir }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const workspaceIdentity = {
    workspace_key: "workspace_card_1",
    workspace_identity_digest: "sha256:workspace",
    workspace_path: "/tmp/workspace-card-1"
  };
  const fizzy = {
    async discoverCandidates() {
      calls.push("discover");
      return [card];
    },
    async listComments() {
      return comments;
    },
    async createComment({ body }) {
      comments.push({
        id: `comment_${comments.length + 1}`,
        body,
        created_at: clock.now().toISOString()
      });
      return { id: `comment_${comments.length}` };
    },
    async postResultComment() {
      calls.push("postResult");
      return { id: "comment_result" };
    },
    async recordCompletionMarker() {
      calls.push("completionMarker");
      return { id: "marker_1" };
    }
  };
  const claims = createBoardClaimStore({
    fizzy,
    status,
    sleep: async () => {},
    ids: {
      claimId: () => "claim_card_1",
      attemptId: () => "attempt_card_1",
      runId: () => "run_card_1"
    }
  });
  const orchestratorState = createOrchestratorState({
    config,
    clock,
    scheduler,
    claims,
    runner: {
      async cancel() {
        calls.push("cancel");
        return { status: "cancelled" };
      }
    }
  });
  let releaseStream;
  let streamStarted;
  const streamStartedPromise = new Promise((resolve) => {
    streamStarted = resolve;
  });
  const streamGate = new Promise((resolve) => {
    releaseStream = resolve;
  });

  const tick = runReconciliationTick({
    config,
    status,
    now: () => clock.now(),
    fizzy,
    router: {
      async validateCandidate({ card: routedCard }) {
        calls.push("route");
        return { action: "spawn", card: routedCard, route };
      }
    },
    claims,
    workspaceManager: {
      async resolveIdentity() {
        return workspaceIdentity;
      },
      async prepare() {
        calls.push("prepareWorkspace");
        return { key: "workspace_card_1", path: "/tmp/workspace-card-1", identity_digest: "sha256:workspace" };
      }
    },
    workflowLoader: {
      async load() {
        return { body: "Renew while running.", front_matter: {} };
      }
    },
    runner: {
      async startSession() {
        return { session_id: "session_1", process_owned: true };
      },
      async startTurn(session) {
        return { turn_id: "turn_1", session_id: session.session_id };
      },
      async stream(turn) {
        calls.push("stream");
        streamStarted();
        await streamGate;
        return { status: "completed", turn_id: turn.turn_id, no_code_change: true };
      }
    },
    orchestratorState
  });

  await streamStartedPromise;
  const renewalTimer = scheduler.pending().find((timer) => timer.delayMs === 500);
  clock.advance(500);
  const renewal = await scheduler.fire(renewalTimer.id);

  assert.equal(renewal.status, "renewed");
  assert.match(comments.at(-1).body, /Status: <strong>renewed<\/strong>/u);
  assert.match(comments.at(-1).body, /<details><summary>Automation marker<\/summary>/u);

  const competingClaims = createBoardClaimStore({ fizzy, status, sleep: async () => {} });
  clock.advance(600);
  const competing = await competingClaims.acquire({
    config,
    card,
    route,
    workspace: workspaceIdentity,
    now: clock.now()
  });

  assert.equal(competing.acquired, false);
  assert.equal(competing.reason, "active_claim");

  releaseStream();
  const result = await tick;
  assert.equal(result.completed, 1);
});

test("runReconciliationTick runs workspace preflight before acquiring a claim", async () => {
  const calls = [];
  const config = configFixture(1);
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const preflightError = new Error("source repo is dirty");
  preflightError.code = "WORKSPACE_SOURCE_DIRTY";

  await assert.rejects(
    () => runReconciliationTick({
      config,
      status,
      now: fixedNow,
      fizzy: {
        async discoverCandidates() {
          calls.push("discover");
          return [card];
        }
      },
      router: {
        async validateCandidate() {
          calls.push("route");
          return { action: "spawn", card, route, prompt: "Do the safe fake turn." };
        }
      },
      claims: {
        async acquire() {
          calls.push("claim");
          throw new Error("claims must not run when workspace preflight fails");
        }
      },
      workspaceManager: {
        async resolveIdentity() {
          calls.push("resolveIdentity");
          return { workspace_identity_digest: "sha256:workspace", workspace_path: "/tmp/workspace" };
        },
        async preflight() {
          calls.push("preflight");
          throw preflightError;
        }
      },
      workflowLoader: {},
      runner: {}
    }),
    (error) => error.code === "WORKSPACE_SOURCE_DIRTY"
  );

  assert.deepEqual(calls, ["discover", "route", "resolveIdentity", "preflight"]);
});

test("runReconciliationTick dispatches due retry entries through routing, preflight, claims, and runner capacity", async () => {
  const calls = [];
  const clock = clockFixture();
  const scheduler = schedulerFixture();
  const config = {
    ...configFixture(1),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-retry-")) }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const orchestratorState = createOrchestratorState({ config, clock, scheduler });

  orchestratorState.startRun({
    run_id: "run_card_1_previous",
    attempt_id: "attempt_card_1_previous",
    attempt_number: 1,
    card,
    route,
    claim: {
      id: "claim_card_1_previous",
      run_id: "run_card_1_previous",
      attempt_id: "attempt_card_1_previous"
    },
    workspace: { key: "workspace_card_1", path: "/tmp/workspace-card-1" }
  });
  orchestratorState.recordFailure("run_card_1_previous", { code: "RUNNER_ERROR", message: "try again" }, {
    retryable: true,
    failure_kind: "runner"
  });
  const retryTimer = scheduler.pending().find((timer) => timer.delayMs === 1000);
  clock.advance(1000);
  await scheduler.fire(retryTimer.id);

  const deps = successfulDependencies({ calls, cards: [], route });
  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    orchestratorState,
    fizzy: deps.fizzy,
    router: {
      async validateCandidate({ card: routedCard, retry }) {
        calls.push("route");
        assert.equal(routedCard.id, "card_1");
        assert.equal(retry.attempt_number, 2);
        return { action: "spawn", card: routedCard, route, prompt: "Do the safe fake turn.", retry };
      }
    },
    claims: {
      async acquire({ decision }) {
        calls.push("claim");
        assert.equal(decision.retry.attempt_number, 2);
        return {
          acquired: true,
          claim: {
            id: "claim_card_1_retry",
            run_id: "run_card_1",
            attempt_id: "attempt_card_1",
            attempt_number: 2
          }
        };
      },
      async release({ status }) {
        calls.push("releaseClaim");
        assert.equal(status, "completed");
        return { released: true };
      }
    },
    workspaceManager: {
      async resolveIdentity() {
        calls.push("resolveIdentity");
        return { workspace_identity_digest: "sha256:workspace", workspace_path: "/tmp/workspace-card-1" };
      },
      async preflight() {
        calls.push("preflight");
        return { status: "ok" };
      },
      async prepare() {
        calls.push("prepareWorkspace");
        return { key: "workspace_card_1", path: "/tmp/workspace-card-1", identity_digest: "sha256:workspace" };
      }
    },
    workflowLoader: deps.workflowLoader,
    runner: deps.runner
  });

  assert.equal(result.dispatched, 1);
  assert.equal(result.completed, 1);
  assert.deepEqual(calls.slice(0, 5), ["discover", "route", "resolveIdentity", "preflight", "claim"]);
  assert.equal(orchestratorState.snapshot().retry_queue[0].status, "consumed");
});

test("runReconciliationTick writes local run attempt records through completion", async () => {
  const calls = [];
  const stateDir = await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-runs-"));
  const config = {
    ...configFixture(2),
    observability: { state_dir: stateDir }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const deps = successfulDependencies({ calls, cards: [card], route });

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    ...deps
  });
  const record = JSON.parse(await readFile(join(stateDir, "runs", "attempt_card_1.json"), "utf8"));

  assert.equal(result.completed, 1);
  assert.equal(record.schema_version, "fizzy-symphony-run-attempt-v1");
  assert.equal(record.run_id, "run_card_1");
  assert.equal(record.attempt_id, "attempt_card_1");
  assert.equal(record.card_id, "card_1");
  assert.equal(record.card_number, 1);
  assert.equal(record.board_id, "board_1");
  assert.equal(record.route_id, route.id);
  assert.equal(record.route_fingerprint, "sha256:route");
  assert.equal(record.workspace_identity_digest, "sha256:workspace");
  assert.equal(record.workspace_path, "/tmp/run_card_1");
  assert.equal(record.claim_id, "claim_card_1");
  assert.equal(record.runner_kind, "cli_app_server");
  assert.equal(record.session_id, "session_1");
  assert.equal(record.turn_id, "turn_1");
  assert.equal(record.status, "completed");
  assert.match(record.proof_digest, /^sha256:/u);
  assert.equal(record.result_comment_id, "comment_1");
});

test("runReconciliationTick consumes agent-rerun and updates one workpad comment in place", async () => {
  const calls = [];
  const config = {
    ...configFixture(1),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-proof-")) },
    workpad: { enabled: true, mode: "single_comment" }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  card.tags = ["agent-rerun"];
  const deps = successfulDependencies({ calls, cards: [card], route });

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    ...deps,
    fizzy: {
      ...deps.fizzy,
      async removeTag({ tag }) {
        calls.push(`removeTag:${tag}`);
        return { removed: true };
      },
      async postWorkpadComment({ body }) {
        calls.push("postWorkpad");
        assert.match(body, /fizzy-symphony:workpad:v1/u);
        return { id: "workpad_1" };
      },
      async updateWorkpadComment({ comment_id, body }) {
        calls.push(`updateWorkpad:${comment_id}`);
        assert.match(body, /fizzy-symphony:workpad:v1/u);
        return { id: comment_id };
      }
    },
    router: {
      async validateCandidate({ card }) {
        calls.push("route");
        return { action: "spawn", card, route, prompt: "Do the safe fake turn.", rerun_requested: true };
      }
    }
  });

  assert.equal(result.completed, 1);
  assert.deepEqual(status.status().rerun_consumptions.map((entry) => entry.tag), ["agent-rerun"]);
  assert.deepEqual(status.status().workpads.map((workpad) => workpad.comment_id), ["workpad_1"]);
  assert.deepEqual(
    calls.filter((call) => call === "postWorkpad" || call.startsWith("updateWorkpad")),
    ["postWorkpad", "updateWorkpad:workpad_1", "updateWorkpad:workpad_1"]
  );
  assert.ok(calls.indexOf("removeTag:agent-rerun") < calls.indexOf("prepareWorkspace"));
});

test("runReconciliationTick records a non-looping completion-failure marker when required steps remain unchecked", async () => {
  const calls = [];
  const config = {
    ...configFixture(1),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-proof-")) }
  };
  const status = statusStore(config);
  const route = routeFixture();
  route.completion = { policy: "comment_once", required_steps_block_completion: true };
  const card = cardFixture("card_1", 1);
  const deps = successfulDependencies({ calls, cards: [card], route });
  let failurePayload;

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    ...deps,
    fizzy: {
      ...deps.fizzy,
      async refreshCard() {
        calls.push("refreshCard");
        return {
          ...card,
          steps: [{ id: "step_1", title: "Verify handoff", checked: false, required: true }]
        };
      },
      async recordCompletionMarker() {
        throw new Error("success marker must not be recorded while required steps are unchecked");
      },
      async recordCompletionFailureMarker({ body, payload }) {
        calls.push("completionFailureMarker");
        failurePayload = parseCompletionFailureMarker(body);
        assert.equal(payload.failure_reason, "required steps remain unchecked");
        return { id: "failure_marker_1" };
      }
    },
    claims: {
      ...deps.claims,
      async release({ status }) {
        calls.push(`releaseClaim:${status}`);
        assert.equal(status, "failed");
        return { released: true };
      }
    }
  });

  assert.equal(result.failed, 1);
  assert.equal(failurePayload.marker, "fizzy-symphony:completion-failed:v1");
  assert.equal(failurePayload.result_comment_id, "comment_1");
  assert.match(failurePayload.proof_digest, /^sha256:/u);
  assert.equal(status.status().runs.failed[0].last_error.code, "COMPLETION_BLOCKED_BY_REQUIRED_STEPS");
  assert.ok(calls.includes("completionFailureMarker"));
  assert.ok(calls.includes("stopSession"));
  assert.ok(!calls.includes("completionMarker"));
});

test("runReconciliationTick records one non-looping failure marker when the runner fails", async () => {
  const calls = [];
  const config = {
    ...configFixture(1),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-runner-failed-")) }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const deps = successfulDependencies({ calls, cards: [card], route });
  const failureMarkers = [];

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    ...deps,
    fizzy: {
      ...deps.fizzy,
      async postResultComment() {
        throw new Error("result comments are only written after runner success");
      },
      async recordCompletionFailureMarker({ body, payload }) {
        calls.push("runnerFailureMarker");
        failureMarkers.push(parseCompletionFailureMarker(body));
        assert.equal(payload.route_fingerprint, route.fingerprint);
        assert.equal(payload.card_digest, failureMarkers[0].card_digest);
        assert.match(payload.failure_reason, /runner exploded/u);
        return { id: "runner_failure_marker_1" };
      }
    },
    runner: {
      ...deps.runner,
      async stream(turn, onEvent) {
        calls.push("stream");
        onEvent?.({ type: "turn.failed", turn_id: turn.turn_id });
        return {
          status: "failed",
          turn_id: turn.turn_id,
          error: { code: "RUNNER_EXPLODED", message: "runner exploded" }
        };
      }
    },
    claims: {
      ...deps.claims,
      async release({ status, completion_marker }) {
        calls.push(`releaseClaim:${status}`);
        assert.equal(status, "failed");
        assert.equal(completion_marker.id, "runner_failure_marker_1");
        return { released: true };
      }
    }
  });

  assert.equal(result.failed, 1);
  assert.equal(failureMarkers.length, 1);
  assert.equal(failureMarkers[0].marker, "fizzy-symphony:completion-failed:v1");
  assert.equal(failureMarkers[0].route_fingerprint, route.fingerprint);
  assert.equal(status.status().runs.failed[0].last_error.code, "RUNNER_EXPLODED");
  assert.equal(status.status().runs.failed[0].completion_marker.id, "runner_failure_marker_1");
  assert.deepEqual(calls.filter((call) => call === "runnerFailureMarker"), ["runnerFailureMarker"]);
});

test("runReconciliationTick releases the claim and does not start the runner when workflow cache has no valid workflow", async () => {
  const calls = [];
  const config = {
    ...configFixture(1),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-workflow-failed-")) }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const workflowError = new Error("Workflow front matter is missing a closing delimiter.");
  workflowError.code = "WORKFLOW_FRONT_MATTER_INVALID";
  workflowError.details = { path: "/repo/app/WORKFLOW.md" };

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    fizzy: {
      async discoverCandidates() {
        calls.push("discover");
        return [card];
      }
    },
    router: {
      async validateCandidate() {
        calls.push("route");
        return { action: "spawn", card, route };
      }
    },
    claims: {
      async acquire() {
        calls.push("claim");
        return {
          acquired: true,
          claim: {
            id: "claim_card_1",
            claim_id: "claim_card_1",
            run_id: "run_card_1",
            attempt_id: "attempt_card_1"
          }
        };
      },
      async release({ status, error }) {
        calls.push(`releaseClaim:${status}:${error.code}`);
        return { released: true };
      }
    },
    workspaceManager: {
      async prepare() {
        calls.push("prepareWorkspace");
        return { key: "workspace_app", sourceRepo: "/repo/app", path: "/tmp/workspace-app" };
      }
    },
    workflowLoader: createCachedWorkflowLoader({
      status,
      loader: async () => {
        calls.push("loadWorkflow");
        throw workflowError;
      }
    }),
    runner: {
      async startSession() {
        calls.push("startSession");
        throw new Error("runner must not start without a workflow");
      }
    },
    orchestratorState: createOrchestratorState({ config })
  });

  assert.equal(result.failed, 1);
  assert.deepEqual(calls, [
    "discover",
    "route",
    "claim",
    "prepareWorkspace",
    "loadWorkflow",
    "releaseClaim:failed:WORKFLOW_FRONT_MATTER_INVALID"
  ]);
  assert.equal(status.status().runs.failed[0].last_error.code, "WORKFLOW_FRONT_MATTER_INVALID");
  assert.equal(status.status().workflow_cache.recent_reload_errors[0].cache_hit, false);
});

test("runReconciliationTick respects max_concurrent minus already running work", async () => {
  const calls = [];
  const config = {
    ...configFixture(2),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-proof-")) }
  };
  const status = statusStore(config);
  const route = routeFixture();
  status.startRun({
    id: "run_already_active",
    card: { id: "card_active", number: 99 },
    board_id: "board_1",
    route,
    claim: { id: "claim_active" }
  });
  const deps = successfulDependencies({
    calls,
    cards: [cardFixture("card_1", 1), cardFixture("card_2", 2), cardFixture("card_3", 3)],
    route
  });

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    ...deps
  });

  assert.equal(result.dispatched, 1);
  assert.deepEqual(
    calls.filter((call) => call === "claim"),
    ["claim"]
  );
  assert.deepEqual(status.status().runs.running.map((run) => run.id), ["run_already_active"]);
  assert.deepEqual(status.status().runs.completed.map((run) => run.id), ["run_card_1"]);
});

test("runReconciliationTick sorts eligible cards before consuming dispatch capacity", async () => {
  const calls = [];
  const config = {
    ...configFixture(1),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-priority-")) }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const lowPriority = { ...cardFixture("card_2", 1), priority: 9 };
  const highPriority = { ...cardFixture("card_1", 99), priority: 1 };
  const deps = successfulDependencies({
    calls,
    cards: [lowPriority, highPriority],
    route
  });

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    ...deps
  });

  assert.equal(result.dispatched, 1);
  assert.equal(result.capacity_refused, 1);
  assert.deepEqual(status.status().runs.completed.map((run) => run.id), ["run_card_1"]);
});

for (const [name, setup, expected] of [
  [
    "global",
    () => ({
      config: configFixture(1),
      activeRoute: routeFixture(),
      candidateRoute: routeFixture(),
      activeCard: cardFixture("card_active", 99),
      candidateCard: cardFixture("card_2", 2)
    }),
    "global_capacity"
  ],
  [
    "board",
    () => ({
      config: {
        ...configFixture(10),
        boards: {
          entries: [{
            id: "board_1",
            label: "Agents",
            enabled: true,
            defaults: { concurrency: { max_concurrent: 1 } }
          }]
        }
      },
      activeRoute: { ...routeFixture(), id: "route_active", fingerprint: "sha256:active" },
      candidateRoute: { ...routeFixture(), id: "route_candidate", fingerprint: "sha256:candidate" },
      activeCard: cardFixture("card_active", 99),
      candidateCard: cardFixture("card_2", 2)
    }),
    "board_capacity"
  ],
  [
    "route",
    () => {
      const route = { ...routeFixture(), concurrency: { max_concurrent: 1 } };
      return {
        config: {
          ...configFixture(10),
          boards: { entries: [{ id: "board_1", label: "Agents", enabled: true, defaults: { concurrency: { max_concurrent: 10 } } }] }
        },
        activeRoute: route,
        candidateRoute: route,
        activeCard: cardFixture("card_active", 99),
        candidateCard: cardFixture("card_2", 2)
      };
    },
    "route_capacity"
  ],
  [
    "card",
    () => ({
      config: {
        ...configFixture(10),
        agent: { ...configFixture(10).agent, max_concurrent_per_card: 1 },
        boards: { entries: [{ id: "board_1", label: "Agents", enabled: true, defaults: { concurrency: { max_concurrent: 10 } } }] }
      },
      activeRoute: { ...routeFixture(), concurrency: { max_concurrent: 10 } },
      candidateRoute: { ...routeFixture(), concurrency: { max_concurrent: 10 } },
      activeCard: cardFixture("card_2", 2),
      candidateCard: cardFixture("card_2", 2)
    }),
    "card_capacity"
  ]
]) {
  test(`runReconciliationTick refuses ${name} capacity before acquiring a claim and exposes the refusal`, async () => {
    const calls = [];
    const { config, activeRoute, candidateRoute, activeCard, candidateCard } = setup();
    const status = statusStore(config);
    status.startRun({
      id: "run_active",
      card: activeCard,
      board_id: activeCard.board_id,
      route: activeRoute,
      claim: { id: "claim_active" }
    });

    const result = await runReconciliationTick({
      config,
      status,
      now: fixedNow,
      fizzy: {
        async discoverCandidates() {
          calls.push("discover");
          return [candidateCard];
        }
      },
      router: {
        async validateCandidate() {
          calls.push("route");
          return { action: "spawn", card: candidateCard, route: candidateRoute };
        }
      },
      claims: {
        async acquire() {
          calls.push("claim");
          throw new Error("claim must not be acquired when capacity is full");
        }
      },
      workspaceManager: {
        async prepare() {
          calls.push("prepareWorkspace");
          throw new Error("workspace must not be prepared when capacity is full");
        }
      },
      workflowLoader: {},
      runner: {}
    });

    assert.equal(result.dispatched, 0);
    assert.equal(result.capacity_refused, 1);
    assert.deepEqual(calls, ["discover", "route"]);
    const refusal = status.status().capacity_refusals[0];
    assert.equal(refusal.reason, expected);
    assert.equal(refusal.card_id, candidateCard.id);
    assert.equal(refusal.board_id, "board_1");
    assert.equal(refusal.route_id, candidateRoute.id);
    assert.equal(refusal.active_count, 1);
    assert.equal(refusal.limit, 1);
  });
}

test("webhook events enqueue candidate hints but still require router validation before claims", async () => {
  const calls = [];
  const config = configFixture(1);
  const status = statusStore(config);

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    webhookEvents: [{
      id: "event_1",
      card_id: "card_hint",
      board_id: "board_1",
      action: "card_closed",
      intent: "cancel_active",
      cancel_reason: "card_closed"
    }],
    fizzy: {
      async discoverCandidates({ hints }) {
        calls.push("discover");
        assert.deepEqual(hints, [{
          event_id: "event_1",
          card_id: "card_hint",
          board_id: "board_1",
          action: "card_closed",
          intent: "cancel_active",
          cancel_reason: "card_closed"
        }]);
        return hints.map((hint) => cardFixture(hint.card_id, 42));
      }
    },
    router: {
      async validateCandidate({ card }) {
        calls.push(`route:${card.id}`);
        return { action: "ignore", reason: "fresh card state is not eligible" };
      }
    },
    claims: {
      async acquire() {
        calls.push("claim");
        throw new Error("claims must not run when router ignores the hinted card");
      }
    },
    workspaceManager: {},
    workflowLoader: {},
    runner: {}
  });

  assert.deepEqual(calls, ["discover", "route:card_hint"]);
  assert.equal(result.dispatched, 0);
  assert.equal(result.ignored, 1);
});

test("webhook golden-ticket refresh hints update routes before candidate discovery", async () => {
  const calls = [];
  const config = {
    ...configFixture(1),
    polling: { use_api_filters: true, api_filters: {} }
  };
  const status = statusStore(config);
  status.setRoutes([{ ...routeFixture(), source_column_id: "col_old" }]);

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    webhookEvents: [{
      event_id: "event_golden",
      card_id: "golden_1",
      board_id: "board_1",
      intent: "refresh_routes",
      reason: "golden_ticket_changed"
    }],
    fizzy: {
      async listGoldenCards({ query }) {
        calls.push(["listGoldenCards", query]);
        return {
          data: [{
            id: "golden_1",
            board_id: "board_1",
            column_id: "col_ready",
            golden: true,
            tags: ["agent-instructions", "move-to-done"]
          }]
        };
      },
      async getBoard(boardId) {
        calls.push(["getBoard", boardId]);
        return {
          id: boardId,
          columns: [
            { id: "col_ready", name: "Ready" },
            { id: "col_done", name: "Done" }
          ],
          cards: []
        };
      },
      async listCards({ query }) {
        calls.push(["listCards", query]);
        assert.deepEqual(query.column_ids, ["col_ready"]);
        return { data: [] };
      }
    },
    router: {},
    claims: {},
    workspaceManager: {},
    workflowLoader: {},
    runner: {}
  });

  assert.equal(result.dispatched, 0);
  assert.deepEqual(calls.map((entry) => entry[0]), ["listGoldenCards", "getBoard", "listCards"]);
  assert.deepEqual(status.status().routes.map((route) => route.golden_card_id), ["golden_1"]);
});

test("polling discovery is the correctness path when webhook hints are absent or missed", async () => {
  const calls = [];
  const config = {
    ...configFixture(1),
    observability: { state_dir: await mkdtemp(join(tmpdir(), "fizzy-symphony-reconciler-proof-")) },
    polling: {
      interval_ms: 30000,
      use_api_filters: true,
      api_filters: {
        tag_ids: ["tag_agent"],
        assignee_ids: ["bot_1"],
        assignment_status: "unassigned",
        indexed_by: "last_active",
        sorted_by: "priority",
        terms: ["codex"]
      }
    }
  };
  const status = statusStore(config);
  const route = routeFixture();
  const deps = successfulDependencies({ calls, cards: [cardFixture("card_1", 1)], route });

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    routes: [route],
    fizzy: {
      async listCards({ query }) {
        calls.push(["listCards", query]);
        return {
          data: [cardFixture("card_1", 1)],
          etag_cache: { hits: 0, misses: 1, invalid: 0 }
        };
      },
      postResultComment: deps.fizzy.postResultComment,
      recordCompletionMarker: deps.fizzy.recordCompletionMarker
    },
    router: deps.router,
    claims: deps.claims,
    workspaceManager: deps.workspaceManager,
    workflowLoader: deps.workflowLoader,
    runner: deps.runner
  });

  assert.deepEqual(calls[0], [
    "listCards",
    {
      board_ids: ["board_1"],
      column_ids: ["col_ready"],
      tag_ids: ["tag_agent"],
      assignee_ids: ["bot_1"],
      assignment_status: "unassigned",
      indexed_by: "last_active",
      sorted_by: "priority",
      terms: ["codex"]
    }
  ]);
  assert.equal(result.dispatched, 1);
  assert.equal(result.completed, 1);
  assert.deepEqual(status.status().runs.completed.map((run) => run.id), ["run_card_1"]);
});

test("poll ticks refresh golden-ticket routes before building candidate filters", async () => {
  const calls = [];
  const config = configFixture(1);
  const status = statusStore(config);
  status.setRoutes([]);

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    fizzy: {
      async listGoldenCards({ query }) {
        calls.push(["listGoldenCards", query]);
        return {
          data: [{
            id: "golden_ready",
            board_id: "board_1",
            column_id: "col_ready",
            golden: true,
            tags: ["agent-instructions", "comment-once"]
          }]
        };
      },
      async getBoard(boardId) {
        calls.push(["getBoard", boardId]);
        return {
          id: boardId,
          columns: [{ id: "col_ready", name: "Ready" }],
          cards: []
        };
      },
      async listCards({ query }) {
        calls.push(["listCards", query]);
        return { data: [] };
      }
    },
    router: {},
    claims: {},
    workspaceManager: {},
    workflowLoader: {},
    runner: {}
  });

  assert.equal(result.discovered, 0);
  assert.deepEqual(calls.at(-1), ["listCards", { board_ids: ["board_1"], column_ids: ["col_ready"] }]);
  assert.deepEqual(status.status().routes.map((route) => route.golden_card_id), ["golden_ready"]);
});

test("runReconciliationTick resolves workspace identity before claim and skips workspace preparation when claim is lost", async () => {
  const calls = [];
  const config = configFixture(1);
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    fizzy: {
      async discoverCandidates() {
        calls.push("discover");
        return [card];
      }
    },
    router: {
      async validateCandidate() {
        calls.push("route");
        return { action: "spawn", card, route, prompt: "Do not run." };
      }
    },
    claims: {
      async acquire({ workspace }) {
        calls.push("claim");
        assert.equal(workspace.workspace_identity_digest, "sha256:workspace");
        return { acquired: false, reason: "lost_claim", live_claim: { claim_id: "claim_other" } };
      }
    },
    workspaceManager: {
      async resolveIdentity() {
        calls.push("resolveWorkspaceIdentity");
        return { workspace_key: "workspace_app", workspace_identity_digest: "sha256:workspace" };
      },
      async prepare() {
        calls.push("prepareWorkspace");
        throw new Error("workspace must not be prepared after a lost claim");
      }
    },
    workflowLoader: {},
    runner: {}
  });

  assert.deepEqual(calls, ["discover", "route", "resolveWorkspaceIdentity", "claim"]);
  assert.equal(result.dispatched, 0);
  assert.equal(result.claim_blocked, 1);
});

test("runReconciliationTick releases a claim when workspace preparation fails after acquisition", async () => {
  const calls = [];
  const config = configFixture(1);
  const status = statusStore(config);
  const route = routeFixture();
  const card = cardFixture("card_1", 1);
  const workspaceError = Object.assign(new Error("worktree add failed"), { code: "WORKSPACE_WORKTREE_CREATE_FAILED" });

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    fizzy: {
      async discoverCandidates() {
        calls.push("discover");
        return [card];
      }
    },
    router: {
      async validateCandidate() {
        calls.push("route");
        return { action: "spawn", card, route };
      }
    },
    claims: {
      async acquire() {
        calls.push("claim");
        return {
          acquired: true,
          claim: {
            id: "claim_card_1",
            claim_id: "claim_card_1",
            run_id: "run_card_1",
            attempt_id: "attempt_card_1"
          }
        };
      },
      async release({ status, error }) {
        calls.push(`releaseClaim:${status}:${error.code}`);
        return { released: true };
      }
    },
    workspaceManager: {
      async resolveIdentity() {
        calls.push("resolveWorkspaceIdentity");
        return { workspace_key: "workspace_app", workspace_identity_digest: "sha256:workspace" };
      },
      async prepare() {
        calls.push("prepareWorkspace");
        throw workspaceError;
      }
    },
    workflowLoader: {},
    runner: {},
    orchestratorState: createOrchestratorState({ config })
  });

  assert.equal(result.failed, 1);
  assert.deepEqual(calls, [
    "discover",
    "route",
    "resolveWorkspaceIdentity",
    "claim",
    "prepareWorkspace",
    "releaseClaim:failed:WORKSPACE_WORKTREE_CREATE_FAILED"
  ]);
  assert.equal(status.status().runs.failed[0].last_error.code, "WORKSPACE_WORKTREE_CREATE_FAILED");
});

test("runReconciliationTick preempts active lifecycle runs when the current route fingerprint changes", async () => {
  const cancellations = [];
  const config = configFixture(1);
  const status = statusStore(config);
  const route = routeFixture();
  const orchestratorState = createOrchestratorState({
    config,
    runner: {
      async cancel(turn, reason) {
        cancellations.push({ turn_id: turn.turn_id, reason });
        return { status: "cancelled" };
      }
    }
  });
  orchestratorState.startRun({
    run_id: "run_card_1",
    attempt_id: "attempt_card_1",
    card: cardFixture("card_1", 1),
    route,
    claim: {
      id: "claim_card_1",
      claim_id: "claim_card_1",
      run_id: "run_card_1",
      attempt_id: "attempt_card_1",
      route_fingerprint: route.fingerprint,
      lease_expires_at: "2026-04-29T12:15:00.000Z"
    },
    workspace: { key: "workspace_card_1", path: "/tmp/workspace-card-1" },
    turn: { turn_id: "turn_card_1" }
  });

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    orchestratorState,
    fizzy: {
      async refreshActiveCards({ activeRuns }) {
        assert.deepEqual(activeRuns.map((run) => run.card_id), ["card_1"]);
        return [{ ...cardFixture("card_1", 1), route_fingerprint: "sha256:new-route" }];
      },
      async discoverCandidates() {
        return [];
      }
    },
    router: {
      async validateCandidate() {
        throw new Error("no candidates should be routed");
      }
    },
    claims: {},
    workspaceManager: {},
    workflowLoader: {},
    runner: {}
  });

  assert.equal(result.dispatched, 0);
  assert.deepEqual(cancellations, [{ turn_id: "turn_card_1", reason: "route_fingerprint_mismatch" }]);
  assert.equal(orchestratorState.snapshot().cancellations[0].reason, "route_fingerprint_mismatch");
});
