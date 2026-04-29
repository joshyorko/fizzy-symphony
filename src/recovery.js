import { access } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { inspectClaimMarkers } from "./claims.js";
import { inspectInstanceRegistry } from "./instance-registry.js";
import { createRunRegistry } from "./run-registry.js";
import { scanWorkspaceMetadata } from "./workspace.js";

const INTERRUPTED_STATUSES = new Set(["running", "claiming", "preparing", "preparing_workspace"]);
const CLEANUP_RECOVERY_STATES = new Set(["cleanup_started", "archive_started"]);
const TERMINAL_CLAIM_STATUSES = new Set(["released", "completed", "failed", "cancelled", "lost"]);
const SAFE_COMPLETION_POLICY_STATES = new Set(["completed", "succeeded", "safely_failed_non_looping", "non_looping_failed"]);

export async function performStartupRecovery(options = {}) {
  const {
    config = {},
    runRegistry = createRunRegistry({ stateDir: config.observability?.state_dir }),
    claimComments = [],
    readClaimComments,
    inspectInstances,
    now = new Date(),
    status
  } = options;
  const recoveredAt = toIso(now);
  const report = {
    schema_version: "fizzy-symphony-startup-recovery-v1",
    recovered_at: recoveredAt,
    stale_instances: {
      removed_stale_instances: [],
      live_instances: [],
      stale_unconfirmed_instances: [],
      warnings: [],
      errors: []
    },
    interrupted_attempts: [],
    preserved_workspaces: [],
    claims: {
      claims: [],
      recoverable_expired_self_claims: [],
      live_self_claim_warnings: [],
      other_live_claims: [],
      expired_other_claims: [],
      terminal_claims: [],
      warnings: []
    },
    cleanup_recovery: {
      recoverable: [],
      preserved: []
    },
    warnings: [],
    errors: []
  };

  const instanceReport = inspectInstances
    ? await inspectInstances()
    : await inspectInstanceRegistry({
      registryDir: config.server?.registry_dir,
      currentInstanceId: config.instance?.id,
      configPath: config.config_path ?? config.path,
      now
    });
  report.stale_instances = normalizeInstanceReport(instanceReport);
  report.warnings.push(...(report.stale_instances.warnings ?? []));
  report.errors.push(...(report.stale_instances.errors ?? []));

  const attempts = await runRegistry.readAttempts();
  for (const attempt of attempts.filter((entry) => INTERRUPTED_STATUSES.has(entry.status))) {
    const updated = await runRegistry.updateAttempt(attempt.attempt_id, {
      status: "interrupted",
      interrupted_at: recoveredAt,
      workspace_preserved: true,
      preservation_reason: "interrupted during previous daemon run",
      updated_at: recoveredAt
    });
    const interrupted = recoveryAttemptSummary(updated, {
      previous_status: attempt.status,
      recovered_status: "interrupted"
    });
    report.interrupted_attempts.push(interrupted);
    report.preserved_workspaces.push(preservedWorkspaceFromAttempt(updated, {
      code: "WORKSPACE_PRESERVED_INTERRUPTED",
      message: "Workspace preserved because the previous daemon stopped during an active attempt."
    }));
  }

  for (const attempt of attempts.filter((entry) => CLEANUP_RECOVERY_STATES.has(cleanupStateName(entry.cleanup_state)))) {
    const cleanup = await evaluateCleanupRecovery({ config, attempt, now });
    if (cleanup.safe_to_resume) {
      await runRegistry.updateAttempt(attempt.attempt_id, {
        cleanup_recovery_state: "safe_to_resume",
        cleanup_recovery_checked_at: recoveredAt,
        updated_at: recoveredAt
      });
      report.cleanup_recovery.recoverable.push(recoveryAttemptSummary(attempt, {
        cleanup_state: cleanupStateName(attempt.cleanup_state),
        recovery_state: "safe_to_resume"
      }));
    } else {
      await runRegistry.updateAttempt(attempt.attempt_id, {
        cleanup_state: "cleanup_preserved",
        cleanup_recovery_state: "manual_intervention_required",
        cleanup_recovery_checked_at: recoveredAt,
        workspace_preserved: true,
        preservation_reason: "cleanup interrupted; manual intervention required",
        manual_intervention_required: true,
        last_error: {
          code: "CLEANUP_RECOVERY_UNSAFE",
          message: "Cleanup recovery checks did not pass.",
          details: { reasons: cleanup.reasons }
        },
        updated_at: recoveredAt
      });
      const preserved = recoveryAttemptSummary(attempt, {
        cleanup_state: cleanupStateName(attempt.cleanup_state),
        recovery_state: "manual_intervention_required",
        reasons: cleanup.reasons
      });
      report.cleanup_recovery.preserved.push(preserved);
      report.preserved_workspaces.push(preservedWorkspaceFromAttempt(attempt, {
        code: "WORKSPACE_PRESERVED_CLEANUP_RECOVERY",
        message: "Workspace preserved because cleanup recovery checks did not pass.",
        details: { reasons: cleanup.reasons }
      }));
      report.warnings.push({
        code: "CLEANUP_RECOVERY_UNSAFE",
        message: "Cleanup recovery requires manual intervention.",
        details: { attempt_id: attempt.attempt_id, reasons: cleanup.reasons }
      });
    }
  }

  const workspaceReport = await scanWorkspaceMetadata({ config });
  report.preserved_workspaces.push(...workspaceReport.preserved_workspaces);
  report.warnings.push(...workspaceReport.warnings);
  report.errors.push(...workspaceReport.errors);

  const comments = readClaimComments ? await readClaimComments({ config }) : claimComments;
  report.claims = inspectClaimMarkers(comments, {
    instanceId: config.instance?.id,
    now
  });
  report.warnings.push(...report.claims.warnings);

  status?.recordStartupRecovery?.(report);
  return report;
}

export async function evaluateCleanupRecovery({ config = {}, attempt = {}, now = new Date() } = {}) {
  const reasons = [];
  const proofFile = attempt.proof_file ?? attempt.proof_path;
  const stateDir = config.observability?.state_dir;
  const proofRoot = stateDir ? resolve(stateDir, "proof") : null;

  if (!proofFile || !(await fileExists(proofFile))) {
    reasons.push(reason("CLEANUP_PROOF_MISSING", "Durable proof file is missing.", { proof_file: proofFile }));
  } else {
    const resolvedProof = resolve(proofFile);
    if (!proofRoot || !isInsideOrSame(resolvedProof, proofRoot)) {
      reasons.push(reason("CLEANUP_PROOF_NOT_DURABLE", "Durable proof is not under observability.state_dir/proof.", {
        proof_file: proofFile,
        proof_root: proofRoot
      }));
    }
    if (attempt.workspace_path && isInsideOrSame(resolvedProof, resolve(attempt.workspace_path))) {
      reasons.push(reason("CLEANUP_PROOF_INSIDE_WORKSPACE", "Durable proof is inside the cleanup target.", {
        proof_file: proofFile,
        workspace_path: attempt.workspace_path
      }));
    }
  }

  if (!attempt.proof_digest) {
    reasons.push(reason("CLEANUP_PROOF_DIGEST_MISSING", "Proof digest is missing."));
  }

  if (!attempt.result_comment_id && !attempt.failure_marker_id) {
    reasons.push(reason("CLEANUP_HANDOFF_MISSING", "Fizzy result comment or failure marker is missing."));
  }

  if (!SAFE_COMPLETION_POLICY_STATES.has(attempt.completion_policy_state)) {
    reasons.push(reason("CLEANUP_COMPLETION_POLICY_UNSAFE", "Completion policy did not finish in a non-looping state.", {
      completion_policy_state: attempt.completion_policy_state
    }));
  }

  if (attempt.terminal_claim_persisted !== true || !TERMINAL_CLAIM_STATUSES.has(attempt.terminal_claim_status)) {
    reasons.push(reason("CLEANUP_TERMINAL_CLAIM_MISSING", "Terminal claim persistence is missing or unverifiable.", {
      terminal_claim_status: attempt.terminal_claim_status,
      terminal_claim_persisted: attempt.terminal_claim_persisted
    }));
  }

  if (!attempt.no_code_change) {
    const missing = ["branch_name", "commit_sha", "pr_url"].filter((field) => !attempt[field]);
    if (missing.length > 0) {
      reasons.push(reason("CLEANUP_CODE_HANDOFF_MISSING", "Code handoff metadata is missing.", { missing }));
    }
  }

  const cleanupPolicy = config.safety?.cleanup_policy ?? config.cleanup?.policy;
  if (cleanupPolicy === "preserve") {
    reasons.push(reason("CLEANUP_POLICY_PRESERVE", "Cleanup policy requires preservation."));
  }

  const workspaceReport = await scanWorkspaceMetadata({ config });
  const matchingWorkspace = workspaceReport.workspaces.find((workspace) => (
    (attempt.workspace_key && workspace.workspace_key === attempt.workspace_key) ||
    (attempt.workspace_path && workspace.workspace_path === attempt.workspace_path)
  ));
  if (!matchingWorkspace) {
    reasons.push(reason("WORKSPACE_METADATA_MISSING", "Workspace metadata for cleanup target is missing.", {
      workspace_key: attempt.workspace_key,
      workspace_path: attempt.workspace_path
    }));
  }
  const preserved = workspaceReport.preserved_workspaces.filter((workspace) => (
    (attempt.workspace_key && workspace.workspace_key === attempt.workspace_key) ||
    (attempt.workspace_path && workspace.workspace_path === attempt.workspace_path)
  ));
  reasons.push(...preserved.map((workspace) => reason(workspace.code, workspace.message, workspace.details ?? workspace)));

  const filesystem = attempt.filesystem_evidence ?? {};
  if (filesystem.clean !== true ||
    (filesystem.untracked_files?.length ?? 0) > 0 ||
    (filesystem.unpushed_commits?.length ?? 0) > 0 ||
    filesystem.branch_merged === false) {
    reasons.push(reason("CLEANUP_FILESYSTEM_UNSAFE", "Filesystem evidence is missing or unsafe for cleanup.", {
      filesystem_evidence: filesystem
    }));
  }

  return {
    safe_to_resume: reasons.length === 0,
    checked_at: toIso(now),
    reasons
  };
}

function normalizeInstanceReport(report = {}) {
  return {
    removed_stale_instances: report.removed_stale_instances ?? [],
    live_instances: report.live_instances ?? [],
    stale_unconfirmed_instances: report.stale_unconfirmed_instances ?? [],
    warnings: report.warnings ?? [],
    errors: report.errors ?? []
  };
}

function recoveryAttemptSummary(attempt, extra = {}) {
  return {
    run_id: attempt.run_id,
    attempt_id: attempt.attempt_id,
    card_id: attempt.card_id,
    board_id: attempt.board_id,
    workspace_key: attempt.workspace_key,
    workspace_path: attempt.workspace_path,
    ...extra
  };
}

function preservedWorkspaceFromAttempt(attempt, extra = {}) {
  return {
    workspace_key: attempt.workspace_key,
    workspace_path: attempt.workspace_path,
    attempt_id: attempt.attempt_id,
    run_id: attempt.run_id,
    preserve_workspace: true,
    ...extra
  };
}

function cleanupStateName(cleanupState) {
  if (typeof cleanupState === "string") return cleanupState;
  return cleanupState?.status;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function reason(code, message, details = {}) {
  return { code, message, details };
}

function isInsideOrSame(path, root) {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith("..") && !remainder.startsWith("/") && remainder !== "..");
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
