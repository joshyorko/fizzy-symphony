import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import {
  createCompletionFailureMarker,
  createCompletionMarker,
  evaluateCleanupEligibility,
  parseCompletionFailureMarker,
  parseCompletionMarker,
  writeDurableProof
} from "../src/completion.js";
import { canonicalJson, cardDigest, digest } from "../src/domain.js";

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

function jsonBlock(body) {
  const match = body.match(/```json\s*([\s\S]*?)\s*```/u);
  assert.ok(match, "expected a fenced JSON block");
  return match[1];
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

  const rawJson = jsonBlock(marker.body);
  const parsed = parseCompletionMarker(marker.body);

  assert.match(marker.tag, /^agent-completed-[a-f0-9]{12}$/u);
  assert.equal(rawJson, canonicalJson(parsed));
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
  assert.equal(jsonBlock(marker.body), canonicalJson(parsed));
  assert.equal(parsed.marker, "fizzy-symphony:completion-failed:v1");
  assert.equal(parsed.kind, "completion_failed");
  assert.equal(parsed.failure_reason, "required steps remain unchecked");
  assert.equal(parsed.result_comment_id, "comment_1");
  assert.equal(parsed.proof_file, "/state/proof/run_1.json");
  assert.equal(parsed.proof_digest, "sha256:proof");
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

test("cleanup eligibility preserves workspace when proof, result, marker, release, or outside proof guard is missing", () => {
  const config = { safety: { cleanup: { policy: "remove_clean_only" } } };
  const workspacePath = "/tmp/workspaces/card_1";
  const complete = {
    config,
    workspace: { path: workspacePath },
    proof: { file: "/tmp/state/proof/run_1.json", digest: "sha256:proof" },
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
