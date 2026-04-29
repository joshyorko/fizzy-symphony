import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runReconciliationTick } from "../src/reconciler.js";
import { createOrchestratorState } from "../src/orchestrator-state.js";
import { createStatusStore } from "../src/status.js";
import { parseCompletionFailureMarker, parseCompletionMarker } from "../src/completion.js";

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
      }
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
  assert.ok(!calls.includes("completionMarker"));
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

test("webhook events enqueue candidate hints but still require router validation before claims", async () => {
  const calls = [];
  const config = configFixture(1);
  const status = statusStore(config);

  const result = await runReconciliationTick({
    config,
    status,
    now: fixedNow,
    webhookEvents: [{ id: "event_1", card_id: "card_hint", board_id: "board_1" }],
    fizzy: {
      async discoverCandidates({ hints }) {
        calls.push("discover");
        assert.deepEqual(hints, [{ event_id: "event_1", card_id: "card_hint", board_id: "board_1" }]);
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
