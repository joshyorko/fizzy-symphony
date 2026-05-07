import { cardBoardId, cardColumnId, cardStatus } from "./fizzy-normalize.js";
import { readClaims } from "./claims.js";

export function createOrchestratorState(options = {}) {
  const {
    config = {},
    clock = { now: () => new Date() },
    scheduler = globalThis,
    claims,
    runner
  } = options;

  const activeRuns = new Map();
  const retryQueue = [];
  const recentFailures = [];
  const claimRenewals = [];
  const stalledRuns = [];
  const cancellations = [];
  const recoveryReport = {};

  function startRun(input = {}) {
    const run = normalizeRun(input, config, clock);
    activeRuns.set(run.run_id, run);
    scheduleRenewal(run);
    scheduleStall(run);
    return clone(run);
  }

  function recordFailure(runId, error = {}, details = {}) {
    const run = activeRuns.get(runId);
    if (!run) return null;
    activeRuns.delete(runId);
    clearRunTimers(run);

    const failure = {
      run_id: run.run_id,
      attempt_id: run.attempt_id,
      card_id: run.card_id,
      error: normalizeError(error),
      failure_kind: details.failure_kind,
      retryable: Boolean(details.retryable),
      terminal: false,
      workspace_preserved: true,
      failed_at: nowIso(clock)
    };

    if (details.retryable && (run.attempt_number ?? 1) < 3) {
      const retry = scheduleRetry(run, details.reason ?? details.failure_kind ?? "failed");
      failure.next_retry_at = retry.next_retry_at;
    } else {
      failure.terminal = true;
      failure.retry_exhausted = Boolean(details.retryable);
    }

    recentFailures.push(failure);
    trim(recentFailures);
    return clone(failure);
  }

  function completeRun(runId, details = {}) {
    const run = activeRuns.get(runId);
    if (!run) return null;
    activeRuns.delete(runId);
    clearRunTimers(run);
    return clone({
      ...run,
      ...details,
      status: "completed",
      completed_at: nowIso(clock)
    });
  }

  function recordRunnerActivity(runId, activity = {}) {
    const run = activeRuns.get(runId);
    if (!run) return null;
    run.last_activity_at = nowIso(clock);
    run.last_activity = clone(activity);
    return clone(run);
  }

  async function renewClaimNow(runId) {
    const run = activeRuns.get(runId);
    if (!run) return { ignored: true, reason: "missing_run" };

    try {
      const renewal = await claims?.renew?.({
        config,
        run,
        card: run.card,
        route: run.route,
        claim: run.claim,
        workspace: run.workspace,
        now: nowIso(clock)
      });
      if (renewal?.renewed === false) {
        return handleRenewalFailure(run, renewal.error ?? renewal, renewal.claim ?? renewal);
      }
      run.claim = { ...(run.claim ?? {}), ...clone(renewal?.claim ?? renewal ?? {}) };
      const entry = {
        run_id: run.run_id,
        status: "renewed",
        renewed_at: nowIso(clock),
        lease_expires_at: renewal?.lease_expires_at ?? renewal?.claim?.expires_at ?? renewal?.claim?.lease_expires_at
      };
      claimRenewals.push(entry);
      trim(claimRenewals);
      scheduleRenewal(run);
      return clone(entry);
    } catch (error) {
      return handleRenewalFailure(run, error);
    }
  }

  async function handleRenewalFailure(run, error = {}, claimUpdate = null) {
    if (claimUpdate) {
      run.claim = { ...(run.claim ?? {}), ...clone(claimUpdate) };
    }
    const expiresAt = run.claim?.lease_expires_at ?? run.claim?.expires_at;
    const expired = expiresAt && Date.parse(expiresAt) <= Date.parse(nowIso(clock));
    const entry = {
      run_id: run.run_id,
      status: expired ? "failed_expired" : "failed",
      error: normalizeError(error),
      renewed_at: nowIso(clock)
    };
    claimRenewals.push(entry);
    trim(claimRenewals);
    if (expired) {
      await cancelRun(run, "claim_renewal_expired", { retry: false });
    } else {
      scheduleRenewal(run);
    }
    return clone(entry);
  }

  async function reconcileActiveCards({ cards = [] } = {}) {
    const byId = new Map(cards.map((card) => [card.id, card]));
    for (const run of [...activeRuns.values()]) {
      const card = byId.get(run.card_id);
      if (!card) continue;
      const reason = cancellationReason(run, card);
      if (reason) await cancelRun(run, reason, { retry: false });
    }
    return snapshot();
  }

  function recoverStartup(report = {}) {
    const normalized = {
      claims: parseRecoveredClaims(report.claimCommentsByCard),
      interrupted_attempts: (report.runRecords ?? [])
        .filter((entry) => ["claiming", "preparing", "preparing_workspace", "running"].includes(entry.status))
        .map((entry) => ({ ...clone(entry), recovered_status: "interrupted" })),
      preserved_workspaces: (report.workspaceMetadata ?? []).map(clone),
      stale_instances: (report.instanceRecords ?? []).filter((entry) => entry.stale).map(clone),
      warnings: [],
      errors: []
    };
    Object.assign(recoveryReport, normalized);
    return clone(normalized);
  }

  function snapshot() {
    return {
      active_runs: [...activeRuns.values()].map(clone),
      retry_queue: clone(retryQueue),
      recent_failures: clone(recentFailures),
      claim_renewals: clone(claimRenewals),
      stalled_runs: clone(stalledRuns),
      cancellations: clone(cancellations),
      recovery_report: clone(recoveryReport)
    };
  }

  async function cancelRun(run, reason, options = {}) {
    await runner?.cancel?.(run.turn ?? {}, reason);
    activeRuns.delete(run.run_id);
    clearRunTimers(run);
    const entry = {
      run_id: run.run_id,
      attempt_id: run.attempt_id,
      card_id: run.card_id,
      reason,
      workspace_preserved: true,
      cancelled_at: nowIso(clock)
    };
    cancellations.push(entry);
    trim(cancellations);
    if (options.retry) {
      scheduleRetry(run, reason);
    }
    return clone(entry);
  }

  function scheduleRetry(run, reason) {
    const attemptNumber = (run.attempt_number ?? 1) + 1;
    const baseBackoff = 1000 * (2 ** Math.max(0, attemptNumber - 2));
    const maxBackoff = config.agent?.max_retry_backoff_ms ?? baseBackoff;
    const backoffMs = Math.min(baseBackoff, maxBackoff);
    const retry = {
      run_id: run.run_id,
      attempt_id: run.attempt_id,
      attempt_number: attemptNumber,
      reason,
      status: "scheduled",
      backoff_ms: backoffMs,
      next_retry_at: new Date(Date.parse(nowIso(clock)) + backoffMs).toISOString(),
      workspace_preserved: true
    };
    retry.timer = scheduler?.setTimeout?.(() => {
      const replacement = [...activeRuns.values()].find((active) => active.card_id === run.card_id);
      if (replacement && replacement.attempt_id !== run.attempt_id) return { ignored: true, reason: "stale_timer" };
      retry.status = "ready";
      return clone(retry);
    }, backoffMs);
    retryQueue.push(retry);
    trim(retryQueue);
    return retry;
  }

  function scheduleRenewal(run) {
    const delay = config.claims?.renew_interval_ms;
    if (!delay || !scheduler?.setTimeout) return;
    if (run.renewal_timer) scheduler?.clearTimeout?.(run.renewal_timer);
    run.renewal_timer = scheduler.setTimeout(() => {
      const current = activeRuns.get(run.run_id);
      if (current?.attempt_id !== run.attempt_id) return { ignored: true, reason: "stale_timer" };
      return renewClaimNow(run.run_id);
    }, delay);
  }

  function scheduleStall(run) {
    const delay = config.agent?.stall_timeout_ms;
    if (!delay || !scheduler?.setTimeout) return;
    run.stall_timer = scheduler.setTimeout(async () => {
      const current = activeRuns.get(run.run_id);
      if (current?.attempt_id !== run.attempt_id) return { ignored: true, reason: "stale_timer" };
      stalledRuns.push({
        run_id: run.run_id,
        attempt_id: run.attempt_id,
        stalled_at: nowIso(clock),
        workspace_preserved: true
      });
      trim(stalledRuns);
      await cancelRun(run, "stalled", { retry: true });
      return snapshot();
    }, delay);
  }

  function clearRunTimers(run) {
    if (run.renewal_timer) scheduler?.clearTimeout?.(run.renewal_timer);
    if (run.stall_timer) scheduler?.clearTimeout?.(run.stall_timer);
  }

  return {
    startRun,
    completeRun,
    recordFailure,
    recordRunnerActivity,
    renewClaimNow,
    reconcileActiveCards,
    cancelRun,
    recoverStartup,
    snapshot
  };
}

function normalizeRun(input, config, clock) {
  const card = input.card ?? {};
  const route = input.route ?? {};
  const claim = input.claim ?? {};
  const workspace = input.workspace ?? {};
  return {
    ...clone(input),
    run_id: input.run_id ?? input.id ?? claim.run_id,
    attempt_id: input.attempt_id ?? claim.attempt_id,
    attempt_number: input.attempt_number ?? 1,
    card_id: input.card_id ?? card.id,
    card_number: input.card_number ?? card.number,
    board_id: input.board_id ?? card.board_id ?? route.board_id,
    route_id: input.route_id ?? route.id,
    route_fingerprint: input.route_fingerprint ?? route.fingerprint ?? claim.route_fingerprint,
    claim_id: input.claim_id ?? claim.claim_id ?? claim.id,
    workspace_key: input.workspace_key ?? workspace.key,
    workspace_path: input.workspace_path ?? workspace.path,
    workspace_preserved: true,
    started_at: input.started_at ?? nowIso(clock),
    instance_id: config.instance?.id
  };
}

function cancellationReason(run, card) {
  const status = cardStatus(card);
  if (status === "closed" || status === "postponed" || card.closed === true || card.postponed === true) return "card_left_eligible_state";
  const boardId = cardBoardId(card);
  const columnId = cardColumnId(card);
  if (boardId && run.board_id && boardId !== run.board_id) return "card_left_eligible_state";
  if (run.route?.source_column_id && columnId && columnId !== run.route.source_column_id) return "card_left_eligible_state";
  if (card.route_fingerprint && card.route_fingerprint !== run.route_fingerprint) return "route_fingerprint_mismatch";
  return null;
}

function parseRecoveredClaims(claimCommentsByCard = {}) {
  return readClaims(Object.values(claimCommentsByCard).flat());
}

function normalizeError(error = {}) {
  if (typeof error === "string") return { code: "ERROR", message: error };
  return {
    code: error.code ?? "ERROR",
    message: error.message ?? String(error)
  };
}

function nowIso(clock) {
  const value = typeof clock?.now === "function" ? clock.now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function trim(entries) {
  if (entries.length > 50) entries.splice(0, entries.length - 50);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (key, entry) => {
    if (key === "timer" || key.endsWith("_timer")) return undefined;
    return entry;
  }));
}
