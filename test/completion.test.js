import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import {
  applyCompletionPolicy,
  createCompletionFailureMarker,
  createCompletionMarker,
  evaluateCleanupEligibility,
  parseCompletionFailureMarker,
  parseCompletionMarker,
  upsertWorkpad,
  writeDurableProof
} from "../src/completion.js";
import { canonicalJson, cardDigest, digest } from "../src/domain.js";
import { createStatusStore } from "../src/status.js";

function route(overrides = {}) {
  return {
    id: "board:board_1:column:col_ready:golden:golden_1",
    board_id: "board_1",
    source_column_id: "col_ready",
    fingerprint: "sha256:route",
    completion: { policy: "comment_once" },
    ...overrides
  };
}

function card(overrides = {}) {
  return {
    id: "card_1",
    number: 42,
    board_id: "board_1",
    column_id: "col_ready",
    title: "Implement proof",
    description: "Persist handoff proof.",
    tags: ["feature"],
    steps: [],
    comments: [],
    ...overrides
  };
}

function run(overrides = {}) {
  return {
    id: "run_1",
    attempt_id: "attempt_1",
    session_id: "session_1",
    turn_id: "turn_1",
    runner_kind: "cli_app_server",
    ...overrides
  };
}

function workspace(overrides = {}) {
  return {
    key: "workspace_1",
    path: "/tmp/workspace_1",
    identity_digest: "sha256:workspace",
    branch_name: "fizzy/board-card-42",
    ...overrides
  };
}

test("completion markers use canonical JSON and include durable proof and result IDs", () => {
  const activeCard = card();
  const activeRoute = route();
  const proof = { file: "/state/proof/run_1.json", digest: "sha256:proof" };
  const marker = createCompletionMarker({
    run: run(),
    route: activeRoute,
    instance: { id: "instance_1" },
    workspace: workspace(),
    card: activeCard,
    proof,
    resultComment: { id: "comment_1" },
    completedAt: "2026-04-29T12:03:00.000Z"
  });

  const parsed = parseCompletionMarker(marker.body);

  assert.match(marker.tag, /^agent-completed-[a-f0-9]{12}$/u);
  assert.match(marker.body, /<p><strong>fizzy-symphony recorded completion\.<\/strong><\/p>/);
  assert.match(marker.body, /<details><summary>Automation marker<\/summary>/);
  assert.doesNotMatch(marker.body, /```json/u);
  assert.match(marker.body, new RegExp(escapeRegExp(canonicalJson(parsed).replaceAll("\"", "&quot;")), "u"));
  assert.equal(parsed.marker, "fizzy-symphony:completion:v1");
  assert.equal(parsed.kind, "completion");
  assert.equal(parsed.run_id, "run_1");
  assert.equal(parsed.route_id, activeRoute.id);
  assert.equal(parsed.route_fingerprint, "sha256:route");
  assert.equal(parsed.instance_id, "instance_1");
  assert.equal(parsed.workspace_key, "workspace_1");
  assert.equal(parsed.workspace_identity_digest, "sha256:workspace");
  assert.equal(parsed.completed_at, "2026-04-29T12:03:00.000Z");
  assert.equal(parsed.card_digest, cardDigest(activeCard, activeRoute));
  assert.equal(parsed.fizzy_result_comment_id, "comment_1");
  assert.equal(parsed.proof_file, "/state/proof/run_1.json");
  assert.equal(parsed.proof_digest, "sha256:proof");
});

test("completion-failure markers parse with proof fields and canonical JSON", () => {
  const marker = createCompletionFailureMarker({
    run: run(),
    route: route(),
    instance: { id: "instance_1" },
    workspace: workspace(),
    card: card(),
    reason: "required steps remain unchecked",
    resultComment: { id: "comment_1" },
    proof: { file: "/state/proof/run_1.json", digest: "sha256:proof" },
    createdAt: "2026-04-29T12:04:00.000Z"
  });

  const parsed = parseCompletionFailureMarker(`operator note\n\n${marker.body}`);

  assert.match(marker.tag, /^agent-completion-failed-[a-f0-9]{12}$/u);
  assert.match(marker.body, /<p><strong>fizzy-symphony recorded a completion problem\.<\/strong><\/p>/);
  assert.match(marker.body, /<details><summary>Automation marker<\/summary>/);
  assert.doesNotMatch(marker.body, /```json/u);
  assert.match(marker.body, new RegExp(escapeRegExp(canonicalJson(parsed).replaceAll("\"", "&quot;")), "u"));
  assert.equal(parsed.marker, "fizzy-symphony:completion-failed:v1");
  assert.equal(parsed.kind, "completion_failed");
  assert.equal(parsed.failure_reason, "required steps remain unchecked");
  assert.equal(parsed.result_comment_id, "comment_1");
  assert.equal(parsed.proof_file, "/state/proof/run_1.json");
  assert.equal(parsed.proof_digest, "sha256:proof");
});

test("completion markers parse when live Fizzy plain text strips HTML sentinels", () => {
  const completion = createCompletionMarker({
    run: run(),
    route: route(),
    instance: { id: "instance_1" },
    workspace: workspace(),
    card: card(),
    proof: { file: "/state/proof/run_1.json", digest: "sha256:proof" },
    resultComment: { id: "comment_1" },
    completedAt: "2026-04-29T12:03:00.000Z"
  });
  const failure = createCompletionFailureMarker({
    run: run(),
    route: route(),
    instance: { id: "instance_1" },
    workspace: workspace(),
    card: card(),
    reason: "required steps remain unchecked",
    createdAt: "2026-04-29T12:04:00.000Z"
  });

  assert.equal(
    parseCompletionMarker(completion.body.replace("<!-- fizzy-symphony-marker -->\n", "")).run_id,
    "run_1"
  );
  assert.equal(
    parseCompletionFailureMarker(failure.body.replace("<!-- fizzy-symphony-marker -->\n", "")).run_id,
    "run_1"
  );
});

test("writeDurableProof stores proof under observability.state_dir/proof outside the workspace cleanup target", async () => {
  const root = await mkdtemp(join(tmpdir(), "fizzy-symphony-proof-"));
  const stateDir = join(root, "state");
  const workspacePath = join(root, "workspace", "card_1");
  const activeCard = card();
  const activeRoute = route();

  const proof = await writeDurableProof({
    config: { observability: { state_dir: stateDir } },
    run: run(),
    card: activeCard,
    route: activeRoute,
    workspace: workspace({ path: workspacePath }),
    result: {
      status: "completed",
      output_summary: "Implemented completion proof.",
      no_code_change: true,
      session_id: "session_1",
      turn_id: "turn_1"
    },
    resultComment: { id: "comment_1" },
    completedAt: "2026-04-29T12:05:00.000Z"
  });

  assert.equal(relative(join(stateDir, "proof"), proof.file).startsWith(".."), false);
  assert.equal(relative(workspacePath, proof.file).startsWith(".."), true);

  const onDisk = JSON.parse(await readFile(proof.file, "utf8"));
  const { proof_digest: proofDigest, ...digestInput } = onDisk;

  assert.equal(onDisk.schema_version, "fizzy-symphony-proof-v1");
  assert.equal(onDisk.run_id, "run_1");
  assert.equal(onDisk.card_digest, cardDigest(activeCard, activeRoute));
  assert.equal(onDisk.result_comment_id, "comment_1");
  assert.equal(onDisk.no_code_change, true);
  assert.equal(proof.digest, proofDigest);
  assert.equal(proofDigest, digest(digestInput));
});

test("writeDurableProof rejects proof storage that resolves inside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "fizzy-symphony-proof-symlink-"));
  const stateDir = join(root, "state");
  const workspacePath = join(root, "workspace", "card_1");
  await mkdir(join(workspacePath, "proof"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await symlink(join(workspacePath, "proof"), join(stateDir, "proof"), "dir");

  await assert.rejects(
    () => writeDurableProof({
      config: { observability: { state_dir: stateDir } },
      run: run(),
      card: card(),
      route: route(),
      workspace: workspace({ path: workspacePath }),
      result: { status: "completed", no_code_change: true },
      resultComment: { id: "comment_1" },
      completedAt: "2026-04-29T12:05:00.000Z"
    }),
    (error) => error.code === "DURABLE_PROOF_INSIDE_WORKSPACE"
  );
});

test("cleanup eligibility preserves workspace when proof, result, marker, release, or outside proof guard is missing", () => {
  const config = { safety: { cleanup: { policy: "remove_clean_only" } } };
  const workspacePath = "/tmp/workspaces/card_1";
  const complete = {
    config,
    workspace: { path: workspacePath },
    proof: { file: "/tmp/state/proof/run_1.json", digest: "sha256:proof", payload: { no_code_change: true } },
    resultComment: { id: "comment_1" },
    completionMarker: { id: "marker_1" },
    claimRelease: { released: true }
  };

  assert.equal(evaluateCleanupEligibility({ ...complete, proof: null }).action, "preserve");
  assert.equal(evaluateCleanupEligibility({ ...complete, resultComment: null }).reason, "result_comment_missing");
  assert.equal(evaluateCleanupEligibility({ ...complete, completionMarker: null }).reason, "completion_marker_missing");
  assert.equal(evaluateCleanupEligibility({ ...complete, claimRelease: { released: false } }).reason, "claim_release_missing");
  assert.equal(
    evaluateCleanupEligibility({
      ...complete,
      proof: { file: join(workspacePath, "proof", "run_1.json"), digest: "sha256:proof" }
    }).reason,
    "durable_proof_outside_workspace_missing"
  );
  assert.equal(evaluateCleanupEligibility(complete).action, "eligible");
});

test("completion policy fails loudly when required Fizzy mutators are unavailable", async () => {
  assert.deepEqual(
    await applyCompletionPolicy({
      fizzy: {},
      card: card(),
      route: route({ completion: { policy: "close" } })
    }),
    {
      success: false,
      code: "COMPLETION_MUTATOR_UNAVAILABLE",
      message: "Fizzy client cannot close cards for completion."
    }
  );

  assert.deepEqual(
    await applyCompletionPolicy({
      fizzy: {},
      card: card(),
      route: route({ completion: { policy: "move_to_column", target_column_id: "col_done" } })
    }),
    {
      success: false,
      code: "COMPLETION_MUTATOR_UNAVAILABLE",
      message: "Fizzy client cannot move cards for completion.",
      details: { target_column_id: "col_done" }
    }
  );
});

test("workpad update failure posts one replacement and records runtime status", async () => {
  const store = createWorkpadStatusStore();
  store.recordWorkpad({
    card_id: "card_1",
    comment_id: "comment_old",
    phase: "claimed",
    updated_at: "2026-04-29T12:00:00.000Z"
  });
  const calls = [];
  let replacementBody = "";

  const result = await upsertWorkpad({
    config: { workpad: { enabled: true, mode: "single_comment" } },
    status: store,
    fizzy: {
      async updateWorkpadComment({ comment_id }) {
        calls.push(`update:${comment_id}`);
        throw Object.assign(new Error("comment is no longer mutable"), { code: "COMMENT_UPDATE_FAILED" });
      },
      async postWorkpadComment({ body }) {
        calls.push("post");
        replacementBody = body;
        return { id: "comment_replacement" };
      }
    },
    card: card(),
    route: route(),
    run: run(),
    workspace: workspace(),
    phase: "runner_completed",
    now: "2026-04-29T12:06:00.000Z"
  });

  assert.deepEqual(calls, ["update:comment_old", "post"]);
  assert.equal(result.action, "replaced");
  assert.equal(result.comment_id, "comment_replacement");
  assert.equal(result.replacement_of_comment_id, "comment_old");
  assert.match(replacementBody, /Replaces failed workpad: <code>comment_old<\/code>/u);
  assert.match(replacementBody, /Run: <code>run_1<\/code>/u);
  assert.match(replacementBody, /Phase: <strong>runner_completed<\/strong>/u);
  assert.match(replacementBody, /Worktree: <code>\/tmp\/workspace_1<\/code>/u);
  assert.match(replacementBody, /<details><summary>Automation marker<\/summary>/u);
  assert.doesNotMatch(replacementBody, /```json/u);

  const snapshot = store.status();
  assert.equal(snapshot.workpads[0].comment_id, "comment_replacement");
  assert.equal(snapshot.workpads[0].replacement_of_comment_id, "comment_old");
  assert.equal(snapshot.workpad_failures[0].failed_comment_id, "comment_old");
  assert.equal(snapshot.workpad_failures[0].replacement_comment_id, "comment_replacement");
  assert.equal(snapshot.workpad_failures[0].error.code, "COMMENT_UPDATE_FAILED");
  assert.equal(snapshot.recent_warnings[0].code, "WORKPAD_UPDATE_FAILED");
});

test("workpad update recovery avoids replacement loops after a replacement attempt", async () => {
  const store = createWorkpadStatusStore();
  store.recordWorkpad({
    card_id: "card_1",
    comment_id: "comment_old",
    phase: "claimed",
    updated_at: "2026-04-29T12:00:00.000Z"
  });
  const calls = [];
  const fizzy = {
    async updateWorkpadComment({ comment_id }) {
      calls.push(`update:${comment_id}`);
      throw Object.assign(new Error("still immutable"), { code: "COMMENT_UPDATE_FAILED" });
    },
    async postWorkpadComment() {
      calls.push("post");
      throw Object.assign(new Error("create failed after retry"), { code: "COMMENT_CREATE_FAILED" });
    }
  };
  const context = {
    config: { workpad: { enabled: true, mode: "single_comment" } },
    status: store,
    fizzy,
    card: card(),
    route: route(),
    run: run(),
    workspace: workspace(),
    phase: "runner_completed"
  };

  const first = await upsertWorkpad({ ...context, now: "2026-04-29T12:06:00.000Z" });
  const second = await upsertWorkpad({ ...context, now: "2026-04-29T12:07:00.000Z" });

  assert.equal(first.action, "preserved_update_failed");
  assert.equal(second.action, "preserved_update_failed");
  assert.deepEqual(calls, ["update:comment_old", "post", "update:comment_old"]);

  const snapshot = store.status();
  assert.equal(snapshot.workpads[0].comment_id, "comment_old");
  assert.equal(snapshot.workpads[0].replacement_attempted_comment_id, "comment_old");
  assert.equal(snapshot.workpad_failures.length, 2);
  assert.equal(snapshot.workpad_failures[0].replacement_error.code, "COMMENT_CREATE_FAILED");
  assert.equal(snapshot.workpad_failures[1].replacement_skipped_reason, "replacement_already_attempted");
});

test("workpad discovery prefers replacement comments after daemon restart", async () => {
  const store = createWorkpadStatusStore();
  const calls = [];
  const activeCard = card({
    comments: [
      {
        id: "comment_old",
        body: workpadCommentBody({
          comment_id: "comment_old",
          updated_at: "2026-04-29T12:00:00.000Z"
        })
      },
      {
        id: "comment_replacement",
        body: workpadCommentBody({
          comment_id: "comment_replacement",
          replacement_of_comment_id: "comment_old",
          updated_at: "2026-04-29T12:06:00.000Z"
        })
      }
    ]
  });

  const result = await upsertWorkpad({
    config: { workpad: { enabled: true, mode: "single_comment" } },
    status: store,
    fizzy: {
      async updateWorkpadComment({ comment_id }) {
        calls.push(`update:${comment_id}`);
        throw Object.assign(new Error("replacement is no longer mutable"), { code: "COMMENT_UPDATE_FAILED" });
      },
      async postWorkpadComment() {
        calls.push("post");
        return { id: "comment_second_replacement" };
      }
    },
    card: activeCard,
    route: route(),
    run: run(),
    workspace: workspace(),
    phase: "runner_completed",
    now: "2026-04-29T12:07:00.000Z"
  });

  assert.deepEqual(calls, ["update:comment_replacement"]);
  assert.equal(result.action, "preserved_update_failed");
  assert.equal(result.comment_id, "comment_replacement");
  assert.equal(result.replacement_of_comment_id, "comment_old");
  assert.equal(result.replacement_skipped_reason, "already_replacement");

  const snapshot = store.status();
  assert.equal(snapshot.workpad_failures[0].failed_comment_id, "comment_replacement");
  assert.equal(snapshot.workpad_failures[0].replacement_skipped_reason, "already_replacement");
});

function createWorkpadStatusStore() {
  return createStatusStore({
    instance: { id: "instance-a" },
    config: {
      runner: { preferred: "cli_app_server" },
      diagnostics: { no_dispatch: true },
      boards: { entries: [] },
      webhook: { enabled: false },
      polling: { interval_ms: 30000 }
    }
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function workpadCommentBody({ comment_id, replacement_of_comment_id, updated_at }) {
  return [
    "<!-- fizzy-symphony-workpad -->",
    "fizzy-symphony:workpad:v1",
    "",
    "```json",
    canonicalJson({
      marker: "fizzy-symphony:workpad:v1",
      card_id: "card_1",
      comment_id,
      replacement_of_comment_id,
      run_id: "run_1",
      phase: "runner_completed",
      updated_at
    }),
    "```"
  ].join("\n");
}
