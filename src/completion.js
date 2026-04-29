import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { canonicalJson, cardDigest, digest } from "./domain.js";
import { FizzySymphonyError } from "./errors.js";

export const COMPLETION_MARKER = "fizzy-symphony:completion:v1";
export const COMPLETION_FAILED_MARKER = "fizzy-symphony:completion-failed:v1";

const MARKER_SENTINEL = "<!-- fizzy-symphony-marker -->";
const WORKPAD_SENTINEL = "<!-- fizzy-symphony-workpad -->";

export function createCompletionMarker({
  run = {},
  route = {},
  instance = {},
  workspace = {},
  card = {},
  proof = {},
  resultComment = {},
  completedAt = new Date()
} = {}) {
  const payload = omitUndefined({
    marker: COMPLETION_MARKER,
    kind: "completion",
    run_id: run.id ?? run.run_id,
    route_id: route.id,
    route_fingerprint: route.fingerprint ?? route.route_fingerprint,
    instance_id: instance.id,
    workspace_key: workspace.key ?? workspace.workspace_key,
    workspace_identity_digest: workspace.identity_digest ?? workspace.workspace_identity_digest,
    completed_at: toIso(completedAt),
    card_digest: card.digest ?? card.card_digest ?? cardDigest(card, route),
    fizzy_result_comment_id: resultComment.id ?? resultComment.comment_id ?? run.result_comment_id,
    proof_file: proof.file ?? proof.proof_file,
    proof_digest: proof.digest ?? proof.proof_digest
  });

  validatePayload(payload, COMPLETION_MARKER, "completion", [
    "run_id",
    "route_id",
    "route_fingerprint",
    "instance_id",
    "workspace_key",
    "workspace_identity_digest",
    "completed_at",
    "card_digest",
    "fizzy_result_comment_id",
    "proof_file",
    "proof_digest"
  ]);

  return {
    tag: `agent-completed-${shortRouteId(payload.route_id)}`,
    body: markerBody(COMPLETION_MARKER, payload),
    payload
  };
}

export function parseCompletionMarker(body) {
  const parsed = parseMarker(body, COMPLETION_MARKER, "MALFORMED_COMPLETION_MARKER");
  validatePayload(parsed, COMPLETION_MARKER, "completion", [
    "run_id",
    "route_id",
    "route_fingerprint",
    "instance_id",
    "workspace_key",
    "workspace_identity_digest",
    "completed_at",
    "card_digest",
    "fizzy_result_comment_id",
    "proof_file",
    "proof_digest"
  ], "MALFORMED_COMPLETION_MARKER");
  return parsed;
}

export function createCompletionFailureMarker({
  run = {},
  route = {},
  instance = {},
  workspace = {},
  card = {},
  reason,
  failure_reason,
  resultComment = {},
  result_comment_id,
  proof,
  createdAt = new Date()
} = {}) {
  const payload = omitUndefined({
    marker: COMPLETION_FAILED_MARKER,
    kind: "completion_failed",
    run_id: run.id ?? run.run_id,
    route_id: route.id,
    route_fingerprint: route.fingerprint ?? route.route_fingerprint,
    instance_id: instance.id,
    workspace_key: workspace.key ?? workspace.workspace_key,
    failure_reason: failure_reason ?? reason,
    result_comment_id: result_comment_id ?? resultComment.id ?? resultComment.comment_id,
    proof_file: proof?.file ?? proof?.proof_file,
    proof_digest: proof?.digest ?? proof?.proof_digest,
    card_digest: card.digest ?? card.card_digest ?? cardDigest(card, route),
    created_at: toIso(createdAt)
  });

  validatePayload(payload, COMPLETION_FAILED_MARKER, "completion_failed", [
    "run_id",
    "route_id",
    "route_fingerprint",
    "instance_id",
    "workspace_key",
    "failure_reason",
    "card_digest"
  ]);

  return {
    tag: `agent-completion-failed-${shortRouteId(payload.route_id)}`,
    body: markerBody(COMPLETION_FAILED_MARKER, payload),
    payload
  };
}

export function parseCompletionFailureMarker(body) {
  const parsed = parseMarker(body, COMPLETION_FAILED_MARKER, "MALFORMED_COMPLETION_FAILURE_MARKER");
  validatePayload(parsed, COMPLETION_FAILED_MARKER, "completion_failed", [
    "run_id",
    "route_id",
    "route_fingerprint",
    "instance_id",
    "workspace_key",
    "failure_reason",
    "card_digest"
  ], "MALFORMED_COMPLETION_FAILURE_MARKER");
  return parsed;
}

export async function writeDurableProof({
  config = {},
  run = {},
  card = {},
  route = {},
  workspace = {},
  result = {},
  resultComment = {},
  completedAt = new Date(),
  fs = { mkdir, rename, writeFile }
} = {}) {
  const stateDir = resolve(config.observability?.state_dir ?? ".fizzy-symphony/run");
  const proofDir = join(stateDir, "proof");
  const runId = run.id ?? run.run_id;
  const proofFile = join(proofDir, `${sanitizePathSegment(runId)}.json`);
  const base = omitUndefined({
    schema_version: "fizzy-symphony-proof-v1",
    run_id: runId,
    attempt_id: run.attempt_id,
    card_id: card.id ?? card.card_id,
    card_number: card.number ?? card.card_number,
    board_id: card.board_id ?? route.board_id,
    route_id: route.id,
    route_fingerprint: route.fingerprint ?? route.route_fingerprint,
    card_digest: card.digest ?? card.card_digest ?? cardDigest(card, route),
    workspace_key: workspace.key ?? workspace.workspace_key,
    workspace_path: workspace.path ?? workspace.workspace_path,
    workspace_identity_digest: workspace.identity_digest ?? workspace.workspace_identity_digest,
    runner_kind: run.runner_kind ?? run.runner?.kind,
    session_id: result.session_id ?? run.session_id ?? run.session?.session_id,
    turn_id: result.turn_id ?? run.turn_id ?? run.turn?.turn_id,
    final_status: result.status,
    output_summary: result.output_summary ?? result.summary,
    validation_evidence: result.validation_evidence,
    result_comment_id: resultComment.id ?? resultComment.comment_id ?? run.result_comment_id,
    branch_name: result.branch_name ?? workspace.branch_name ?? run.branch_name,
    commit_sha: result.commit_sha ?? run.commit_sha,
    pr_url: result.pr_url ?? result.pull_request_url ?? run.pr_url,
    no_code_change: result.no_code_change === true ? true : undefined,
    started_at: run.started_at,
    completed_at: toIso(completedAt),
    proof_file: proofFile
  });
  const proofDigest = digest(base);
  const payload = { ...base, proof_digest: proofDigest };
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const tmpPath = join(dirname(proofFile), `.${basename(proofFile)}.${process.pid}.${Date.now()}.tmp`);

  await fs.mkdir(proofDir, { recursive: true });
  await fs.writeFile(tmpPath, body, "utf8");
  await fs.rename(tmpPath, proofFile);

  return {
    file: proofFile,
    digest: proofDigest,
    payload
  };
}

export async function upsertWorkpad({
  config = {},
  status,
  fizzy,
  card = {},
  route = {},
  run = {},
  workspace = {},
  phase = "claimed",
  proof,
  resultComment,
  now = new Date()
} = {}) {
  if (config.workpad?.enabled === false || config.workpad?.mode === "disabled") return null;

  const existing = status?.getWorkpad?.(card.id) ?? findWorkpadComment(card.comments);
  const body = workpadBody({ card, route, run, workspace, phase, proof, resultComment, now });
  let response;
  let action;

  if (existing?.comment_id) {
    if (fizzy?.updateWorkpadComment) {
      response = await fizzy.updateWorkpadComment({ card, route, run, comment_id: existing.comment_id, body });
      action = "updated";
    } else if (fizzy?.updateComment) {
      response = await fizzy.updateComment({ card, comment_id: existing.comment_id, body });
      action = "updated";
    }
  }

  if (!response) {
    if (fizzy?.postWorkpadComment) {
      response = await fizzy.postWorkpadComment({ card, route, run, body });
      action = "created";
    } else if (fizzy?.createComment) {
      response = await fizzy.createComment({ card, body });
      action = "created";
    } else if (existing?.comment_id) {
      response = { id: existing.comment_id };
      action = "preserved";
    } else {
      return null;
    }
  }

  const workpad = {
    id: card.id,
    card_id: card.id,
    route_id: route.id,
    route_fingerprint: route.fingerprint ?? route.route_fingerprint,
    run_id: run.id ?? run.run_id,
    comment_id: response.id ?? response.comment_id ?? existing?.comment_id,
    phase,
    action,
    updated_at: toIso(now)
  };
  status?.recordWorkpad?.(workpad);
  return workpad;
}

export function requiredUncheckedSteps(card = {}, route = {}, workflow = {}) {
  const policy = requiredStepPolicy(route, workflow);
  if (!policy.enabled) return [];

  return (card.steps ?? []).filter((step) => {
    if (isStepChecked(step)) return false;
    return policy.blockAllUnchecked || isStepRequired(step);
  });
}

export async function applyCompletionPolicy({ fizzy, card, route }) {
  const completion = route?.completion ?? {};

  try {
    if (fizzy?.applyCompletionPolicy) {
      return normalizePolicyResult(await fizzy.applyCompletionPolicy({ card, route, completion }));
    }

    if (completion.policy === "comment_once") return { success: true, policy: "comment_once" };

    if (completion.policy === "close") {
      if (fizzy?.closeCard) await fizzy.closeCard({ card, route });
      else if (fizzy?.close) await fizzy.close({ card, route });
      return { success: true, policy: "close" };
    }

    if (completion.policy === "move_to_column") {
      if (!completion.target_column_id) {
        return {
          success: false,
          code: "COMPLETION_TARGET_MISSING",
          message: "Move-to completion target column is missing."
        };
      }
      if (fizzy?.moveCardToColumn) {
        await fizzy.moveCardToColumn({ card, route, column_id: completion.target_column_id });
      } else if (fizzy?.moveCard) {
        await fizzy.moveCard({ card, route, column_id: completion.target_column_id });
      }
      return { success: true, policy: "move_to_column", target_column_id: completion.target_column_id };
    }

    return {
      success: false,
      code: "COMPLETION_POLICY_INVALID",
      message: `Unsupported completion policy: ${completion.policy ?? "missing"}`
    };
  } catch (error) {
    return {
      success: false,
      code: error.code ?? "COMPLETION_POLICY_FAILED",
      message: error.message ?? String(error),
      details: error.details ?? {}
    };
  }
}

export function evaluateCleanupEligibility({
  config = {},
  workspace = {},
  proof,
  result = {},
  resultComment,
  completionMarker,
  completionPolicyResult = { success: true },
  claimRelease
} = {}) {
  const policy = config.safety?.cleanup?.policy ?? "preserve";
  if (policy === "preserve") return preserve("cleanup_policy_preserve");
  if (!proof?.file || !proof?.digest) return preserve("proof_missing");
  if (workspace.path && isInsideOrSame(proof.file, workspace.path)) {
    return preserve("durable_proof_outside_workspace_missing");
  }
  if (!(resultComment?.id ?? resultComment?.comment_id)) return preserve("result_comment_missing");
  if (!completionMarker?.id && !completionMarker?.body && !completionMarker?.payload) {
    return preserve("completion_marker_missing");
  }
  const missingHandoff = missingCodeHandoff({ proof, result, workspace });
  if (missingHandoff.length > 0) {
    return { ...preserve("code_handoff_missing"), missing: missingHandoff };
  }
  if (claimRelease && claimRelease.released !== true && claimRelease.status !== "released" && claimRelease.status !== "completed") {
    return preserve("claim_release_missing");
  }
  if (claimRelease === null || claimRelease === undefined) return preserve("claim_release_missing");
  if (completionPolicyResult?.success === false) return preserve("completion_policy_failed");
  return { action: "eligible", reason: "guards_passed", policy };
}

function preserve(reason) {
  return { action: "preserve", reason };
}

function missingCodeHandoff({ proof = {}, result = {}, workspace = {} } = {}) {
  const payload = proof.payload ?? {};
  const noCodeChange = payload.no_code_change === true ||
    proof.no_code_change === true ||
    result.no_code_change === true ||
    workspace.no_code_change === true;
  if (noCodeChange) return [];

  const handoff = {
    branch_name: payload.branch_name ?? result.branch_name ?? workspace.branch_name,
    commit_sha: payload.commit_sha ?? result.commit_sha ?? workspace.commit_sha,
    pr_url: payload.pr_url ?? payload.pull_request_url ?? result.pr_url ?? result.pull_request_url ?? workspace.pr_url
  };
  return Object.entries(handoff)
    .filter(([, value]) => value === undefined || value === null || value === "")
    .map(([field]) => field);
}

function markerBody(marker, payload) {
  return [
    MARKER_SENTINEL,
    marker,
    "",
    "```json",
    canonicalJson(payload),
    "```"
  ].join("\n");
}

function parseMarker(body, marker, code) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = String(body).match(
    new RegExp(`<!--\\s*fizzy-symphony-marker\\s*-->\\s*${escaped}\\s*\`\`\`json\\s*([\\s\\S]*?)\\s*\`\`\``, "u")
  );
  if (!match) {
    throw new FizzySymphonyError(code, "Completion marker Markdown block was not found.");
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    throw new FizzySymphonyError(code, "Completion marker is not valid JSON.", {
      cause: error.message
    });
  }

  return parsed;
}

function validatePayload(payload, marker, kind, requiredFields, code = "INVALID_COMPLETION_MARKER") {
  const missing = requiredFields.filter((field) => payload?.[field] === undefined || payload?.[field] === null || payload?.[field] === "");
  if (payload?.marker !== marker || payload?.kind !== kind || missing.length > 0) {
    throw new FizzySymphonyError(code, "Completion marker is missing required fields.", {
      marker: payload?.marker,
      kind: payload?.kind,
      missing
    });
  }
}

function shortRouteId(routeId) {
  return createHash("sha256").update(String(routeId)).digest("hex").slice(0, 12);
}

function sanitizePathSegment(value) {
  return String(value ?? "run").replace(/[^A-Za-z0-9._-]/gu, "_");
}

function findWorkpadComment(comments = []) {
  const comment = (comments ?? []).find((entry) => commentBody(entry).includes(WORKPAD_SENTINEL));
  if (!comment) return null;
  return {
    card_id: comment.card_id,
    comment_id: comment.id ?? comment.comment_id
  };
}

function workpadBody({ card, route, run, workspace, phase, proof, resultComment, now }) {
  const payload = omitUndefined({
    marker: "fizzy-symphony:workpad:v1",
    card_id: card.id,
    route_id: route.id,
    route_fingerprint: route.fingerprint ?? route.route_fingerprint,
    run_id: run.id ?? run.run_id,
    workspace_key: workspace.key ?? workspace.workspace_key,
    phase,
    proof_file: proof?.file,
    proof_digest: proof?.digest,
    result_comment_id: resultComment?.id ?? resultComment?.comment_id,
    updated_at: toIso(now)
  });

  return [
    WORKPAD_SENTINEL,
    "fizzy-symphony:workpad:v1",
    "",
    `Run: ${payload.run_id ?? "pending"}`,
    `Phase: ${phase}`,
    proof?.file ? `Proof: ${proof.file}` : "",
    "",
    "```json",
    canonicalJson(payload),
    "```"
  ].filter((line) => line !== "").join("\n");
}

function requiredStepPolicy(route, workflow) {
  const routeCompletion = route?.completion ?? {};
  const frontMatter = workflow?.front_matter ?? workflow?.frontMatter ?? {};
  const workflowCompletion = frontMatter.completion ?? {};
  const enabled = Boolean(
    route.required_steps_block_completion ??
    route.required_step_blockers ??
    routeCompletion.required_steps_block_completion ??
    routeCompletion.block_on_unchecked_required_steps ??
    workflowCompletion.required_steps_block_completion ??
    workflowCompletion.block_on_unchecked_required_steps ??
    frontMatter.required_steps_block_completion
  );
  const blockAllUnchecked = Boolean(
    route.unchecked_steps_block_completion ??
    routeCompletion.unchecked_steps_block_completion ??
    workflowCompletion.unchecked_steps_block_completion ??
    frontMatter.unchecked_steps_block_completion
  );

  return { enabled, blockAllUnchecked };
}

function isStepChecked(step) {
  return Boolean(step?.checked ?? step?.is_checked ?? step?.completed ?? step?.complete ?? false);
}

function isStepRequired(step) {
  return Boolean(
    step?.required ??
    step?.required_for_completion ??
    step?.blocks_completion ??
    step?.completion_blocker
  );
}

function normalizePolicyResult(result) {
  if (result?.success === false || result?.ok === false) {
    return {
      success: false,
      code: result.code ?? "COMPLETION_POLICY_FAILED",
      message: result.message ?? "Completion policy failed.",
      details: result.details ?? {}
    };
  }
  return { success: true, ...(result ?? {}) };
}

function isInsideOrSame(path, root) {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const remainder = relative(resolvedRoot, resolvedPath);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

function commentBody(comment) {
  if (typeof comment === "string") return comment;
  return String(comment?.body ?? comment?.content ?? comment?.text ?? "");
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function omitUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}
