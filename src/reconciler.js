import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildCandidateQuery, discoverPollingCandidates, refreshGoldenTicketRegistry } from "./polling.js";
import {
  applyCompletionPolicy,
  createCompletionFailureMarker,
  createCompletionMarker,
  evaluateCleanupEligibility,
  requiredUncheckedSteps,
  upsertWorkpad,
  writeDurableProof
} from "./completion.js";
import { cardDigest } from "./domain.js";
import { FizzySymphonyError } from "./errors.js";
import { cardBoardId, cardColumnId, cardStatus } from "./fizzy-normalize.js";
import { sortDispatchCandidates } from "./router.js";
import { renderPrompt } from "./workflow.js";

const MAX_LOGGED_DIRTY_PATHS = 10;
const execFileAsync = promisify(execFile);

export async function runReconciliationTick(options = {}) {
  const {
    config = {},
    status,
    fizzy,
    router,
    claims,
    workspaceManager,
    workflowLoader,
    runner,
    orchestratorState,
    routes,
    webhookEvents = [],
    logger,
    now = () => new Date()
  } = options;

  const startedAt = currentIso(now);
  status?.recordPoll?.({ startedAt, error: null });

  const result = {
    discovered: 0,
    dispatched: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    preempted: 0,
    ignored: 0,
    claim_blocked: 0,
    capacity_refused: 0
  };

  try {
    const reconciled = await reconcileActiveRuns({
      config,
      status,
      fizzy,
      router,
      claims,
      workspaceManager,
      runner,
      orchestratorState,
      now: startedAt
    });
    result.cancelled = reconciled.cancelled;
    result.preempted = reconciled.preempted;

    let knownRoutes = routes ?? status?.status?.().routes ?? [];
    knownRoutes = await refreshRoutesForPoll({ config, status, fizzy, currentRoutes: knownRoutes });

    const hints = webhookEvents.map((event) => omitUndefined({
      event_id: event.id ?? event.event_id,
      card_id: event.card_id,
      board_id: event.board_id,
      action: event.action,
      intent: event.intent,
      cancel_reason: event.cancel_reason,
      rerun_requested: event.rerun_requested
    }));
    const query = buildCandidateQuery({ config, routes: knownRoutes });
    const candidatesResult = typeof fizzy.discoverCandidates === "function"
      ? await fizzy.discoverCandidates({ config, hints, routes: knownRoutes, query })
      : await discoverPollingCandidates({ config, routes: knownRoutes, fizzy });
    const candidates = mergeRetryCandidates(
      normalizeCandidates(candidatesResult),
      orchestratorState?.readyRetries?.({ now: startedAt }) ?? []
    );
    result.discovered = candidates.length;
    recordEtagStats(status, candidatesResult, fizzy);

    if (config.diagnostics?.no_dispatch) {
      result.ignored += candidates.length;
      recordLifecycle(status, orchestratorState);
      status?.recordPoll?.({ completedAt: startedAt, error: null });
      return result;
    }

    const capacity = createCapacityTracker({ config, status, orchestratorState });
    const dispatchDecisions = [];

    for (const candidate of candidates) {
      const { card: candidateCard, retry } = splitCandidate(candidate);
      const card = await hydrateCardForRouting({ fizzy, card: candidateCard });
      if (reconciled.card_ids.has(card.id)) {
        result.ignored += 1;
        continue;
      }

      const decision = await router.validateCandidate({ config, card, status, retry });
      if (decision?.action !== "spawn" && decision?.spawn !== true) {
        result.ignored += 1;
        continue;
      }

      dispatchDecisions.push({ ...decision, retry: decision.retry ?? retry, card: decision.card ?? card });
    }

    for (const decision of sortDispatchCandidates(dispatchDecisions)) {
      const card = decision.card;
      const capacityRefusal = capacity.refusalFor({ card, route: decision.route, at: startedAt });
      if (capacityRefusal) {
        status?.recordCapacityRefusal?.(capacityRefusal);
        result.capacity_refused += 1;
        result.ignored += 1;
        continue;
      }

      const workspaceIdentity = await resolveWorkspaceIdentity({ config, card, decision, workspaceManager });
      const preflight = await workspaceManager?.preflight?.({
        config,
        card,
        route: decision.route,
        decision,
        identity: workspaceIdentity,
        workspace: workspaceIdentity
      });
      logWorkspacePreflight(logger, preflight);
      const claimResult = await claims.acquire({
        config,
        card,
        route: decision.route,
        decision,
        workspace: workspaceIdentity,
        now: startedAt
      });
      if (!claimResult?.acquired) {
        result.claim_blocked += 1;
        continue;
      }

      if (decision.retry) {
        orchestratorState?.consumeRetry?.(decision.retry, {
          replacement_run_id: claimResult.claim?.run_id ?? claimResult.claim?.runId,
          replacement_attempt_id: claimResult.claim?.attempt_id ?? claimResult.claim?.attemptId
        });
      }

      if (decision.rerun_requested) {
        await consumeRerunSignal({ config, status, fizzy, card, route: decision.route, decision, now: startedAt });
      }

      capacity.reserve({ card, route: decision.route });
      result.dispatched += 1;

      const runResult = await runCard({
        config,
        status,
        fizzy,
        claims,
        workspaceManager,
        workflowLoader,
        runner,
        orchestratorState,
        card,
        decision,
        claim: claimResult.claim,
        workspaceIdentity,
        logger,
        now: startedAt
      });

      if (runResult.status === "completed") result.completed += 1;
      if (runResult.status === "failed") result.failed += 1;
    }

    recordLifecycle(status, orchestratorState);
    status?.recordPoll?.({ completedAt: startedAt, error: null });
    return result;
  } catch (error) {
    recordLifecycle(status, orchestratorState);
    status?.recordPoll?.({ completedAt: currentIso(now), error });
    logReconciliationError(logger, error, { config });
    throw error;
  }
}

function logWorkspacePreflight(logger, preflight) {
  if (!logger || preflight?.status !== "source_dirty_warning") return;

  const dirtyPaths = Array.isArray(preflight.dirty_paths) ? preflight.dirty_paths : [];
  logger.warn?.("workspace.source_dirty_continuing", {
    code: preflight.code ?? "WORKSPACE_SOURCE_DIRTY_WARNING",
    message: preflight.message ?? "Source repository has local changes; continuing from the committed source ref.",
    source_repository_path: preflight.source_repository_path,
    dirty_paths: dirtyPaths.slice(0, MAX_LOGGED_DIRTY_PATHS),
    dirty_paths_count: preflight.dirty_paths_count ?? dirtyPaths.length,
    dirty_paths_truncated: dirtyPaths.length > MAX_LOGGED_DIRTY_PATHS,
    uncommitted_changes_included: preflight.uncommitted_changes_included ?? false,
    dirty_source_repo_policy: preflight.dirty_source_repo_policy,
    remediation: preflight.remediation ?? "Commit first if the agent needs these edits; otherwise dispatch continues from the committed ref."
  });
}

function logReconciliationError(logger, error, { config = {} } = {}) {
  if (!logger) return;

  if (error?.code === "WORKSPACE_SOURCE_DIRTY") {
    const dirtyPaths = Array.isArray(error.details?.dirty_paths) ? error.details.dirty_paths : [];
    logger.warn?.("workspace.source_dirty_protected", {
      code: error.code,
      message: "Source repository has local changes; preserving work and skipping dispatch.",
      source_repository_path: error.details?.source_repository_path,
      dirty_paths: dirtyPaths.slice(0, MAX_LOGGED_DIRTY_PATHS),
      dirty_paths_count: dirtyPaths.length,
      dirty_paths_truncated: dirtyPaths.length > MAX_LOGGED_DIRTY_PATHS,
      preserve_workspace: error.details?.preserve_workspace,
      dirty_source_repo_policy: config.safety?.dirty_source_repo_policy ?? "warn",
      remediation: "Commit, stash, or explicitly change the dirty source repo policy before retrying."
    });
    return;
  }

  logger.error?.("reconciliation.tick_failed", {
    code: error?.code ?? "RECONCILIATION_TICK_FAILED",
    message: error?.message ?? String(error),
    details: error?.details
  });
}

async function resolveWorkspaceIdentity({ config, card, decision, workspaceManager }) {
  if (typeof workspaceManager?.resolveIdentity !== "function") return null;
  return workspaceManager.resolveIdentity({
    config,
    card,
    route: decision.route,
    decision
  });
}

async function refreshRoutesForPoll({ config, status, fizzy, currentRoutes = [] } = {}) {
  if (config.routing?.refresh_golden_tickets_on_poll === false) return currentRoutes;
  if (typeof fizzy?.listGoldenCards !== "function" || typeof fizzy?.getBoard !== "function") {
    return currentRoutes;
  }

  const refreshed = await refreshGoldenTicketRegistry({ config, fizzy });
  const routes = refreshed.routes ?? currentRoutes;
  status?.setRoutes?.(routes);
  return routes;
}

async function hydrateCardForRouting({ fizzy, card = {} } = {}) {
  if (Array.isArray(card.comments)) return card;
  const comments = await listCommentsIfAvailable(fizzy, card);
  if (!Array.isArray(comments)) return card;
  return { ...card, comments };
}

async function listCommentsIfAvailable(fizzy, card) {
  if (typeof fizzy?.listComments === "function") return fizzy.listComments({ card, cardId: card.id, card_id: card.id });
  if (typeof fizzy?.listCardComments === "function") return fizzy.listCardComments({ card, cardId: card.id, card_id: card.id });
  if (typeof fizzy?.getCardComments === "function") return fizzy.getCardComments({ card, cardId: card.id, card_id: card.id });
  return null;
}

async function reconcileActiveRuns({
  config,
  status,
  fizzy,
  router,
  claims,
  workspaceManager,
  runner,
  orchestratorState,
  now
}) {
  const result = emptyReconciliation();
  if (!fizzy?.refreshActiveCards) {
    recordLifecycle(status, orchestratorState);
    return result;
  }

  const statusActiveRuns = status?.status?.().runs?.running ?? [];
  if (statusActiveRuns.length > 0) {
    const cards = normalizeCandidates(await fizzy.refreshActiveCards({ config, activeRuns: statusActiveRuns }));
    const cardsById = new Map(cards.map((card) => [card.id, card]));

    for (const activeRun of statusActiveRuns) {
      const refreshedCard = cardsById.get(activeRun.card_id);
      const renewal = await claims?.renew?.({ config, run: activeRun, claim: activeRun.claim, now });
      if (renewal?.renewed === false) {
        await cancelStatusRun({
          config,
          status,
          fizzy,
          claims,
          workspaceManager,
          runner,
          run: activeRun,
          card: refreshedCard,
          reason: "claim_renewal_failed",
          finalStatus: "cancelled",
          now
        });
        result.cancelled += 1;
        result.card_ids.add(activeRun.card_id);
        continue;
      }

      const ineligibleReason = activeRunIneligibleReason(activeRun, refreshedCard);
      if (ineligibleReason) {
        await cancelStatusRun({
          config,
          status,
          fizzy,
          claims,
          workspaceManager,
          runner,
          run: activeRun,
          card: refreshedCard,
          reason: ineligibleReason,
          finalStatus: "cancelled",
          now
        });
        result.cancelled += 1;
        result.card_ids.add(activeRun.card_id);
        continue;
      }

      const decision = await router?.validateCandidate?.({ config, card: refreshedCard, status, activeRun });
      const currentFingerprint = decision?.route?.fingerprint ?? refreshedCard?.route_fingerprint;
      if (currentFingerprint && currentFingerprint !== activeRun.route_fingerprint) {
        await cancelStatusRun({
          config,
          status,
          fizzy,
          claims,
          workspaceManager,
          runner,
          run: activeRun,
          card: refreshedCard,
          reason: "route_fingerprint_changed",
          finalStatus: "preempted",
          now,
          cancellationDetails: {
            previous_route_fingerprint: activeRun.route_fingerprint,
            current_route_fingerprint: currentFingerprint
          }
        });
        result.preempted += 1;
        result.card_ids.add(activeRun.card_id);
      }
    }
  }

  const lifecycleActiveRuns = orchestratorState?.snapshot?.().active_runs ?? [];
  if (lifecycleActiveRuns.length > 0) {
    const cards = normalizeCandidates(await fizzy.refreshActiveCards({ config, activeRuns: lifecycleActiveRuns }));
    const before = orchestratorState.snapshot();
    await orchestratorState.reconcileActiveCards({ cards });
    const after = orchestratorState.snapshot();
    const newCancellations = (after.cancellations ?? []).slice((before.cancellations ?? []).length);
    for (const cancellation of newCancellations) {
      if (cancellation.reason === "route_fingerprint_mismatch") {
        result.preempted += 1;
      } else {
        result.cancelled += 1;
      }
      if (cancellation.card_id) result.card_ids.add(cancellation.card_id);
    }
  }

  recordLifecycle(status, orchestratorState);
  return result;
}

function emptyReconciliation() {
  return { cancelled: 0, preempted: 0, card_ids: new Set() };
}

async function cancelStatusRun({
  config,
  status,
  fizzy,
  claims,
  workspaceManager,
  runner,
  run,
  card,
  reason,
  finalStatus,
  now,
  cancellationDetails = {}
}) {
  const cancellation = {
    final_status: finalStatus,
    reason,
    requested_at: currentIso(now),
    states: {
      cancel_requested: { status: "done", at: currentIso(now) },
      runner_cancel_sent: { status: "skipped" },
      session_stopped: { status: "skipped" },
      claim_cancelled: { status: "pending" },
      workspace_preserved: { status: "pending" }
    },
    workspace_preserved: false,
    manual_intervention_required: false,
    ...cancellationDetails
  };

  const cancelResult = await cancelRunnerTurn({ config, runner, run, reason });
  cancellation.states.runner_cancel_sent = cancelResult.state;
  if (cancelResult.result) cancellation.runner_cancel = cancelResult.result;

  if (run.session) {
    const stopResult = await stopRunnerSession({ config, runner, run });
    cancellation.states.session_stopped = stopResult.state;
    if (stopResult.result) cancellation.session_stop = stopResult.result;

    const ownedProcess = run.session?.process_owned === true ||
      (run.session?.process_owned === undefined && cancelResult.state.status === "failed");
    if (stopResult.state.status !== "succeeded" && ownedProcess) {
      const terminateResult = await terminateOwnedRunnerProcess({ runner, run });
      cancellation.states.process_terminated = terminateResult.state;
      if (terminateResult.result) cancellation.process_termination = terminateResult.result;
    } else if (stopResult.state.status !== "succeeded") {
      cancellation.manual_intervention_required = true;
    }
  }

  try {
    const release = await claims?.release?.({ config, card: run.card, claim: run.claim, run, status: "cancelled", now, reason });
    cancellation.claim_release = release ?? { released: true };
    cancellation.states.claim_cancelled = release?.released === false || release?.status === "failed"
      ? { status: "failed", at: currentIso(now), result: release }
      : { status: "succeeded", at: currentIso(now), result: release };
  } catch (error) {
    cancellation.claim_release = { released: false, error: normalizeError(error) };
    cancellation.states.claim_cancelled = { status: "failed", at: currentIso(now), error: normalizeError(error) };
  }

  try {
    const preservation = await workspaceManager?.preserve?.({ config, run, card, reason, finalStatus });
    cancellation.workspace_preserved = true;
    cancellation.workspace_preservation = preservation ?? { status: "preserved" };
    cancellation.states.workspace_preserved = {
      status: "preserved",
      at: currentIso(now),
      reason,
      workspace_path: preservation?.workspace_path ?? run.workspace_path ?? run.workspace?.path,
      result: preservation
    };
  } catch (error) {
    cancellation.workspace_preserved = false;
    cancellation.workspace_preservation = { status: "failed", error: normalizeError(error) };
    cancellation.states.workspace_preserved = { status: "failed", at: currentIso(now), error: normalizeError(error) };
    cancellation.manual_intervention_required = true;
  }

  cancellation.manual_intervention_required = cancellation.manual_intervention_required ||
    cancellation.states.runner_cancel_sent.status === "timeout" ||
    cancellation.states.claim_cancelled.status === "failed" ||
    (
      cancellation.states.session_stopped?.status === "failed" &&
      cancellation.states.process_terminated?.status !== "succeeded"
    );

  const comment = await fizzy?.postCancellationComment?.({ run, card, reason, finalStatus, cancellation });
  const details = {
    cancellation,
    cancellation_comment_id: comment?.id,
    final_status: finalStatus
  };
  const cancelled = finalStatus === "preempted"
    ? status?.preemptRun?.(run.id, cancellation, details)
    : status?.cancelRun?.(run.id, cancellation, details);
  await writeRunAttempt(status, cancelled ?? { ...run, cancellation }, finalStatus);
  return cancelled;
}

async function cancelRunnerTurn({ config, runner, run, reason }) {
  if (!runner?.cancel || !run.turn) {
    return { state: { status: "skipped", reason: "no_active_turn" } };
  }

  try {
    const result = await withOptionalTimeout(runner.cancel(run.turn, reason), config.runner?.cancel_timeout_ms);
    if (result?.timeout) return { state: { status: "timeout" } };
    const succeeded = result?.success !== false && result?.status !== "failed" && result?.status !== "timeout";
    return { state: { status: succeeded ? "succeeded" : "failed" }, result };
  } catch (error) {
    return { state: { status: "failed" }, result: { status: "failed", error: normalizeError(error) } };
  }
}

async function stopRunnerSession({ config, runner, run }) {
  if (!runner?.stopSession || !run.session) {
    return { state: { status: "skipped", reason: "no_session" } };
  }
  try {
    const result = await withOptionalTimeout(runner.stopSession(run.session), config?.runner?.stop_session_timeout_ms);
    if (result?.timeout) return { state: { status: "timeout" }, result };
    const succeeded = result?.success !== false && result?.status !== "failed";
    return { state: { status: succeeded ? "succeeded" : "failed" }, result };
  } catch (error) {
    return { state: { status: "failed" }, result: { status: "failed", error: normalizeError(error) } };
  }
}

async function terminateOwnedRunnerProcess({ runner, run }) {
  if (!runner?.terminateOwnedProcess || !run.session) {
    return { state: { status: "skipped", reason: "no_owned_process_terminator" } };
  }
  try {
    const result = await runner.terminateOwnedProcess(run.session);
    const succeeded = result?.success !== false && result?.status !== "failed";
    return { state: { status: succeeded ? "succeeded" : "failed" }, result };
  } catch (error) {
    return { state: { status: "failed" }, result: { status: "failed", error: normalizeError(error) } };
  }
}

async function finalizeRunnerSession({ config, runner, run }) {
  const finalization = {
    states: {
      session_stopped: { status: "skipped" },
      process_terminated: { status: "skipped" }
    },
    manual_intervention_required: false
  };

  if (!run?.session) return finalization;

  const stopResult = await stopRunnerSession({ config, runner, run });
  finalization.states.session_stopped = stopResult.state;
  if (stopResult.result) finalization.session_stop = stopResult.result;

  if (stopResult.state.status !== "succeeded") {
    if (run.session.process_owned === true) {
      const terminateResult = await terminateOwnedRunnerProcess({ runner, run });
      finalization.states.process_terminated = terminateResult.state;
      if (terminateResult.result) finalization.process_termination = terminateResult.result;
      finalization.manual_intervention_required = terminateResult.state.status !== "succeeded";
    } else {
      finalization.manual_intervention_required = true;
    }
  }

  return finalization;
}

function activeRunIneligibleReason(run, card) {
  if (!card) return "card_missing";
  const status = cardStatus(card);
  if (card.closed === true || status === "closed") return "card_closed";
  if (card.auto_postponed === true) return "card_auto_postponed";
  if (card.postponed === true || status === "postponed" || status === "not_now" || status === "not now") {
    return "card_postponed";
  }
  const boardId = cardBoardId(card);
  const columnId = cardColumnId(card);
  if (boardId && run.board_id && boardId !== run.board_id) return "card_board_changed";
  if (run.route?.source_column_id && columnId && columnId !== run.route.source_column_id) {
    return "card_left_routed_column";
  }
  return null;
}

function normalizeCandidates(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.candidates)) return result.candidates;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.snapshot)) return result.snapshot;
  return [];
}

function mergeRetryCandidates(candidates = [], retries = []) {
  if (!retries.length) return candidates;
  const retryCandidates = retries
    .filter((retry) => retry?.card?.id)
    .map((retry) => ({ ...retry.card, retry }));
  const retryCardIds = new Set(retryCandidates.map((candidate) => candidate.id));
  return [
    ...retryCandidates,
    ...candidates.filter((candidate) => !retryCardIds.has(candidate?.id))
  ];
}

function splitCandidate(candidate = {}) {
  const { retry, ...card } = candidate;
  return { card, retry };
}

function recordEtagStats(status, candidatesResult, fizzy) {
  const etagCache = candidatesResult?.etag_cache ?? fizzy?.etagStats?.();
  if (etagCache) {
    status?.recordPoll?.({ etag_cache: etagCache });
  }
}

function createCapacityTracker({ config = {}, status, orchestratorState } = {}) {
  const runs = activeCapacityRuns(status, orchestratorState);
  const counts = {
    global: runs.length,
    cards: countBy(runs, (run) => run.card_id),
    boards: countBy(runs, (run) => run.board_id),
    routes: countBy(runs, routeCapacityKey)
  };

  return {
    refusalFor({ card = {}, route = {}, at } = {}) {
      const globalLimit = numericLimit(config.agent?.max_concurrent ?? 1);
      const globalActive = counts.global;
      if (globalLimit !== null && globalActive >= globalLimit) {
        return capacityRefusal("global_capacity", "global", globalLimit, globalActive, card, route, at);
      }

      const cardLimit = numericLimit(config.agent?.max_concurrent_per_card ?? 1);
      const cardKey = card.id;
      const cardActive = cardKey ? counts.cards.get(cardKey) ?? 0 : 0;
      if (cardLimit !== null && cardActive >= cardLimit) {
        return capacityRefusal("card_capacity", "card", cardLimit, cardActive, card, route, at);
      }

      const boardLimit = numericLimit(boardConcurrencyLimit(config, card.board_id ?? route.board_id));
      const boardKey = card.board_id ?? route.board_id;
      const boardActive = boardKey ? counts.boards.get(boardKey) ?? 0 : 0;
      if (boardLimit !== null && boardActive >= boardLimit) {
        return capacityRefusal("board_capacity", "board", boardLimit, boardActive, card, route, at);
      }

      const routeLimit = numericLimit(route?.concurrency?.max_concurrent);
      const routeKey = routeCapacityKey({ route_id: route?.id, route_fingerprint: route?.fingerprint ?? route?.route_fingerprint });
      const routeActive = routeKey ? counts.routes.get(routeKey) ?? 0 : 0;
      if (routeLimit !== null && routeActive >= routeLimit) {
        return capacityRefusal("route_capacity", "route", routeLimit, routeActive, card, route, at);
      }

      return null;
    },
    reserve({ card = {}, route = {} } = {}) {
      counts.global += 1;
      increment(counts.cards, card.id);
      increment(counts.boards, card.board_id ?? route.board_id);
      increment(counts.routes, routeCapacityKey({ route_id: route?.id, route_fingerprint: route?.fingerprint ?? route?.route_fingerprint }));
    }
  };
}

function activeCapacityRuns(status, orchestratorState) {
  const snapshot = status?.status?.() ?? {};
  const statusRuns = snapshot.runs?.running ?? snapshot.active_runs ?? [];
  const lifecycleRuns = orchestratorState?.snapshot?.().active_runs ?? [];
  const byId = new Map();

  for (const run of [...statusRuns, ...lifecycleRuns]) {
    const normalized = normalizeCapacityRun(run);
    if (!normalized.key) continue;
    byId.set(normalized.key, normalized);
  }

  return [...byId.values()];
}

function normalizeCapacityRun(run = {}) {
  const card = run.card ?? {};
  const route = run.route ?? {};
  return {
    key: run.id ?? run.run_id ?? run.attempt_id,
    card_id: run.card_id ?? card.id,
    board_id: run.board_id ?? card.board_id ?? route.board_id,
    route_id: run.route_id ?? route.id,
    route_fingerprint: run.route_fingerprint ?? route.fingerprint ?? route.route_fingerprint
  };
}

function capacityRefusal(reason, scope, limit, activeCount, card, route, at) {
  return {
    reason,
    scope,
    limit,
    active_count: activeCount,
    card,
    route,
    refused_at: at
  };
}

function boardConcurrencyLimit(config = {}, boardId) {
  return (config.boards?.entries ?? []).find((entry) => entry.id === boardId)?.defaults?.concurrency?.max_concurrent ??
    (config.boards?.entries ?? []).find((entry) => entry.id === boardId)?.concurrency?.max_concurrent;
}

function routeCapacityKey(run = {}) {
  return run.route_fingerprint ?? run.route_id ?? "";
}

function countBy(entries, keyFn) {
  const counts = new Map();
  for (const entry of entries) {
    increment(counts, keyFn(entry));
  }
  return counts;
}

function increment(counts, key) {
  if (!key) return;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function numericLimit(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.trunc(number));
}

function recordLifecycle(status, orchestratorState) {
  if (!status?.recordLifecycleSnapshot || !orchestratorState?.snapshot) return;
  const snapshot = orchestratorState.snapshot();
  status.recordLifecycleSnapshot({
    active_runs: snapshot.active_runs ?? [],
    claims: snapshot.claims ?? [],
    claim_renewals: snapshot.claim_renewals ?? [],
    retry_queue: snapshot.retry_queue ?? [],
    stalled_runs: snapshot.stalled_runs ?? [],
    cancellations: snapshot.cancellations ?? [],
    recent_failures: snapshot.recent_failures ?? []
  });
}

async function runCard({
  config,
  status,
  fizzy,
  claims,
  workspaceManager,
  workflowLoader,
  runner,
  orchestratorState,
  card,
  decision,
  claim,
  workspaceIdentity,
  logger,
  now
}) {
  const runId = claim.run_id ?? claim.runId ?? `run_${card.id}`;
  const attemptId = claim.attempt_id ?? claim.attemptId;
  const route = decision.route;
  const initialCardDigest = cardDigest(card, route);

  let run = status?.startRun?.({
    id: runId,
    attempt_id: attemptId,
    card,
    board_id: card.board_id ?? route?.board_id,
    route,
    card_digest: initialCardDigest,
    claim,
    runner: { kind: config.runner?.preferred ?? route?.backend },
    started_at: now,
    updated_at: now
  }) ?? { id: runId, attempt_id: attemptId, card, route, claim };

  await writeRunAttempt(status, run, "claimed");
  await writeRunAttempt(status, run, "preparing_workspace");

  let workspace;
  let workflow;
  let failureKind = "dispatch";

  try {
    logCardProgress(logger, "card.dispatch_started", { card, route });
    failureKind = "workspace";
    workspace = await workspaceManager.prepare({
      config,
      card,
      route,
      claim,
      decision,
      identity: workspaceIdentity,
      workspace: workspaceIdentity,
      now
    });
    logCardProgress(logger, "card.workspace_prepared", { card, route, workspace });
    failureKind = "workflow";
    workflow = await workflowLoader.load({ config, card, route, claim, workspace, decision });
    run = status?.startRun?.({
      ...run,
      workspace,
      workflow: workflowSummary(workflow)
    }) ?? { ...run, workspace, workflow: workflowSummary(workflow) };

    await writeRunAttempt(status, run, "running");
    failureKind = "workpad";
    const workpad = await upsertWorkpad({ config, status, fizzy, card, route, run, workspace, phase: "claimed", now });

    failureKind = "runner";
    const session = await runner.startSession(workspace.path, { config, route, workflow }, { run_id: runId });
    run = status?.startRun?.({ ...run, session }) ?? { ...run, session };
    await writeRunAttempt(status, run, "running");

    const prompt = decision.prompt ?? workflow?.prompt ?? renderRunPrompt({
      workflow,
      card,
      route,
      workspace,
      workpad,
      claim,
      config,
      attempt: claim.attempt_number ?? claim.attemptNumber ?? 1
    });
    const turnExecution = await runSameThreadTurns({
      config,
      status,
      runner,
      orchestratorState,
      run,
      runId,
      attemptId,
      card,
      route,
      claim,
      workspace,
      session,
      prompt,
      logger
    });
    run = turnExecution.run;
    const streamResult = turnExecution.result;
    if (streamResult?.status !== "completed") {
      throw runnerFailure(streamResult);
    }
    logCardProgress(logger, "card.runner_completed", { card, route, workspace, run });

    failureKind = "after_run";
    const afterRunHook = await runAfterRunHook({
      workspaceManager,
      config,
      run,
      card,
      route,
      claim,
      workspace,
      workflow,
      result: streamResult,
      turn_results: streamResult.turn_results ?? [streamResult],
      now
    });
    if (afterRunHook) {
      run = status?.startRun?.({ ...run, after_run_hook: afterRunHook }) ?? { ...run, after_run_hook: afterRunHook };
      await writeRunAttempt(status, run, "running");
    }

    failureKind = "completion";
    await upsertWorkpad({ config, status, fizzy, card, route, run, workspace, phase: "runner_completed", now });

    const refreshedCard = await refreshCardForCompletion({ fizzy, card, route });
    assertRouteStillCurrent(refreshedCard, route);

    const proofReference = durableProofReference({ config, run });
    const resultComment = await fizzy.postResultComment({ run, card: refreshedCard, route, workspace, result: streamResult, proof: proofReference });
    const proof = await writeDurableProof({
      config,
      run,
      card: refreshedCard,
      route,
      workspace,
      result: streamResult,
      resultComment,
      completedAt: now
    });

    const blockers = requiredUncheckedSteps(refreshedCard, route, workflow);
    if (blockers.length > 0) {
      const failureMarker = createCompletionFailureMarker({
        run,
        card: refreshedCard,
        route,
        instance: config.instance,
        workspace,
        reason: "required steps remain unchecked",
        resultComment,
        proof,
        createdAt: now
      });
      const recordedFailureMarker = await recordCompletionFailureMarker({
        fizzy,
        run,
        card: refreshedCard,
        route,
        workspace,
        result: streamResult,
        resultComment,
        proof,
        marker: failureMarker
      });
      const error = completionFailure("COMPLETION_BLOCKED_BY_REQUIRED_STEPS", "Required steps remain unchecked.", {
        unchecked_steps: blockers.map(normalizeStepForError)
      });
      const failed = status?.failRun?.(runId, error);
      orchestratorState?.recordFailure?.(runId, error, { retryable: false, failure_kind: "completion" });
      recordLifecycle(status, orchestratorState);
      const runnerSessionFinalization = await finalizeRunnerSession({ config, runner, run: { ...(failed ?? run), session } });
      await writeRunAttempt(status, {
        ...(failed ?? run),
        completion_marker: recordedFailureMarker,
        proof,
        result_comment_id: resultComment?.id,
        runner_session_finalization: runnerSessionFinalization
      }, "failed");
      await upsertWorkpad({ config, status, fizzy, card: refreshedCard, route, run: failed ?? run, workspace, phase: "completion_failed", proof, resultComment, now });
      await claims.release({ config, card: refreshedCard, claim, run: failed ?? run, status: "failed", now, error, completion_marker: recordedFailureMarker });
      logCardProgress(logger, "card.dispatch_failed", { card: refreshedCard, route, workspace, run: failed ?? run, error });
      return { status: "failed", run: failed ?? run, error };
    }

    const completionPolicyResult = await applyCompletionPolicy({ fizzy, card: refreshedCard, route });
    if (completionPolicyResult.success === false) {
      const failureMarker = createCompletionFailureMarker({
        run,
        card: refreshedCard,
        route,
        instance: config.instance,
        workspace,
        reason: completionPolicyResult.message,
        resultComment,
        proof,
        createdAt: now
      });
      const recordedFailureMarker = await recordCompletionFailureMarker({
        fizzy,
        run,
        card: refreshedCard,
        route,
        workspace,
        result: streamResult,
        resultComment,
        proof,
        marker: failureMarker
      });
      const error = completionFailure(completionPolicyResult.code, completionPolicyResult.message, completionPolicyResult.details);
      const failed = status?.failRun?.(runId, error);
      orchestratorState?.recordFailure?.(runId, error, { retryable: false, failure_kind: "completion" });
      recordLifecycle(status, orchestratorState);
      const runnerSessionFinalization = await finalizeRunnerSession({ config, runner, run: { ...(failed ?? run), session } });
      await writeRunAttempt(status, {
        ...(failed ?? run),
        completion_marker: recordedFailureMarker,
        proof,
        result_comment_id: resultComment?.id,
        runner_session_finalization: runnerSessionFinalization
      }, "failed");
      await upsertWorkpad({ config, status, fizzy, card: refreshedCard, route, run: failed ?? run, workspace, phase: "completion_failed", proof, resultComment, now });
      await claims.release({ config, card: refreshedCard, claim, run: failed ?? run, status: "failed", now, error, completion_marker: recordedFailureMarker });
      logCardProgress(logger, "card.dispatch_failed", { card: refreshedCard, route, workspace, run: failed ?? run, error });
      return { status: "failed", run: failed ?? run, error };
    }

    const completionMarker = createCompletionMarker({
      run,
      card: refreshedCard,
      route,
      instance: config.instance,
      workspace,
      resultComment,
      proof,
      completedAt: now
    });
    const recordedCompletionMarker = await recordCompletionMarker({
      fizzy,
      run,
      card: refreshedCard,
      route,
      workspace,
      result: streamResult,
      resultComment,
      proof,
      marker: completionMarker
    });

    const runnerSessionFinalization = await finalizeRunnerSession({ config, runner, run: { ...run, session } });

    const completed = status?.completeRun?.(runId, {
      proof,
      result_comment_id: resultComment?.id,
      completion_marker: recordedCompletionMarker,
      runner_result: streamResult,
      runner_session_finalization: runnerSessionFinalization,
      completed_at: now
    });

    const claimRelease = await claims.release({ config, card: refreshedCard, claim, run: completed ?? run, status: "completed", now });
    orchestratorState?.completeRun?.(runId, { proof, result_comment_id: resultComment?.id });
    recordLifecycle(status, orchestratorState);
    let cleanup = evaluateCleanupEligibility({
      config,
      workspace,
      proof,
      result: streamResult,
      resultComment,
      completionMarker: recordedCompletionMarker,
      completionPolicyResult,
      claimRelease
    });

    if (cleanup.action === "eligible" && typeof workspaceManager?.cleanup === "function") {
      status?.recordCleanupState?.({
        status: "cleanup_started",
        reason: cleanup.reason
      });
      await writeRunAttempt(status, {
        ...(completed ?? run),
        proof,
        result_comment_id: resultComment?.id,
        completion_marker: recordedCompletionMarker,
        cleanup_state: "cleanup_started"
      }, "cleanup_started");
      try {
        cleanup = await workspaceManager.cleanup({
          config,
          run: completed ?? run,
          card: refreshedCard,
          route,
          workspace,
          proof,
          result: streamResult,
          resultComment,
          completionMarker: recordedCompletionMarker,
          completionPolicyResult,
          claimRelease
        });
      } catch (error) {
        cleanup = {
          action: "preserve",
          reason: "cleanup_failed",
          error: normalizeError(error)
        };
      }
    }

    const cleanupStatus = cleanupStatusName(cleanup);
    status?.recordCleanupState?.({
      status: cleanupStatus,
      reason: cleanup.reason
    });
    await upsertWorkpad({ config, status, fizzy, card: refreshedCard, route, run: completed ?? run, workspace, phase: "handoff", proof, resultComment, now });
    await writeRunAttempt(status, { ...(completed ?? run), cleanup_state: cleanupStatus }, "completed");
    logCardProgress(logger, "card.dispatch_completed", { card: refreshedCard, route, workspace, run: completed ?? run });
    return { status: "completed", run: completed ?? run };
  } catch (error) {
    const failureMarker = failureKind === "runner"
      ? await recordRunnerFailureMarker({ config, fizzy, run, card, route, workspace, error, now })
      : null;
    orchestratorState?.recordFailure?.(runId, error, {
      retryable: failureKind === "runner" && isRetryableRunnerError(error),
      failure_kind: failureKind
    });
    recordLifecycle(status, orchestratorState);
    const failed = status?.failRun?.(runId, error, failureMarker ? { completion_marker: failureMarker } : {});
    const runnerSessionFinalization = await finalizeRunnerSession({ config, runner, run: failed ?? run });
    await writeRunAttempt(status, {
      ...(failed ?? run),
      completion_marker: failureMarker ?? undefined,
      runner_session_finalization: runnerSessionFinalization
    }, "failed");
    await claims.release?.({
      config,
      card,
      claim,
      run: failed ?? run,
      status: "failed",
      now,
      error,
      completion_marker: failureMarker ?? undefined
    });
    logCardProgress(logger, "card.dispatch_failed", { card, route, workspace, run: failed ?? run, error });
    return { status: "failed", run: failed ?? run, error };
  }
}

async function runSameThreadTurns({
  config,
  status,
  runner,
  orchestratorState,
  run,
  runId,
  attemptId,
  card,
  route,
  claim,
  workspace,
  session,
  prompt,
  logger
}) {
  const maxTurns = Math.max(1, Math.trunc(Number(config.agent?.max_turns ?? 1)) || 1);
  const turnResults = [];
  let currentPrompt = prompt;
  let currentRun = run;
  let lastResult = null;

  for (let turnNumber = 1; turnNumber <= maxTurns; turnNumber += 1) {
    const turn = await runner.startTurn(session, currentPrompt, {
      run_id: runId,
      card_id: card.id,
      route_id: route?.id,
      turn_number: turnNumber,
      max_turns: maxTurns
    });
    currentRun = status?.startRun?.({ ...currentRun, turn }) ?? { ...currentRun, turn };
    await writeRunAttempt(status, currentRun, "running");
    if (turnNumber === 1) {
      logCardProgress(logger, "card.runner_started", { card, route, workspace, run: currentRun });
    }
    orchestratorState?.startRun?.({
      run_id: runId,
      attempt_id: attemptId,
      attempt_number: claim.attempt_number ?? claim.attemptNumber ?? 1,
      card,
      route,
      claim,
      workspace,
      session,
      turn,
      runner: { kind: config.runner?.preferred ?? route?.backend }
    });
    recordLifecycle(status, orchestratorState);

    lastResult = await runner.stream(turn, (event) => {
      status?.recordRunnerEvent?.(runId, event);
      orchestratorState?.recordRunnerActivity?.(runId, event);
    });
    turnResults.push(lastResult);

    if (lastResult?.status !== "completed") break;
    if (!runnerRequestedContinuation(lastResult)) break;
    if (turnNumber >= maxTurns) {
      throw runnerMaxTurnsReached(lastResult, { turnNumber, maxTurns });
    }

    currentPrompt = continuationPrompt(lastResult);
    if (!currentPrompt) {
      throw runnerContinuationFailure(lastResult);
    }
  }

  return {
    run: currentRun,
    result: aggregateTurnResults(turnResults, lastResult)
  };
}

function runnerRequestedContinuation(result = {}) {
  return result.continue === true ||
    result.continue_requested === true ||
    typeof result.next_prompt === "string" ||
    typeof result.continuation_prompt === "string" ||
    typeof result.followup_prompt === "string";
}

function continuationPrompt(result = {}) {
  return result.next_prompt ?? result.continuation_prompt ?? result.followup_prompt;
}

function runnerContinuationFailure(result = {}) {
  const error = new Error("Runner requested same-thread continuation without a continuation prompt.");
  error.code = "RUNNER_CONTINUATION_PROMPT_MISSING";
  error.details = { result };
  return error;
}

function runnerMaxTurnsReached(result = {}, details = {}) {
  const error = new Error("Runner requested same-thread continuation after agent.max_turns was reached.");
  error.code = "RUNNER_MAX_TURNS_REACHED";
  error.details = { result, ...details };
  return error;
}

function aggregateTurnResults(turnResults = [], lastResult = null) {
  const result = lastResult ?? turnResults.at(-1) ?? { status: "completed" };
  return {
    ...result,
    turn_results: turnResults
  };
}

async function runAfterRunHook(context = {}) {
  const { workspaceManager } = context;
  const hookContext = omitUndefined({
    config: context.config,
    run: context.run,
    card: context.card,
    route: context.route,
    claim: context.claim,
    workspace: context.workspace,
    workflow: context.workflow,
    result: context.result,
    turn_results: context.turn_results,
    now: context.now
  });

  if (typeof workspaceManager?.afterRun === "function") {
    return workspaceManager.afterRun(hookContext);
  }
  if (typeof workspaceManager?.runHook === "function") {
    return workspaceManager.runHook("after_run", hookContext);
  }
  return runWorkflowAfterRunHook({ workflow: context.workflow, workspace: context.workspace });
}

async function runWorkflowAfterRunHook({ workflow, workspace } = {}) {
  const spec = (workflow?.frontMatter?.hooks ?? workflow?.front_matter?.hooks ?? {}).after_run;
  if (!spec) return null;
  const cwd = workspace?.path ?? workspace?.workspace_path;
  if (!cwd) {
    throw new FizzySymphonyError("WORKSPACE_HOOK_FAILED", "Workspace lifecycle hook failed.", {
      hook: "after_run",
      cause: "workspace_path_missing"
    });
  }

  const commands = normalizeHookCommands(spec);
  const results = [];
  for (const argv of commands) {
    const result = await runHookCommand(argv, { cwd });
    results.push({ argv, ...result });
  }
  return { hook: "after_run", commands: results };
}

function normalizeHookCommands(spec) {
  if (typeof spec === "string") return [singleStringCommand(spec)];
  if (Array.isArray(spec)) {
    if (spec.every((entry) => typeof entry === "string")) return [spec];
    return spec.flatMap(normalizeHookCommands);
  }
  if (spec && typeof spec === "object") {
    if (Array.isArray(spec.commands)) return spec.commands.flatMap(normalizeHookCommands);
    if (typeof spec.command === "string") {
      const args = spec.args === undefined ? [] : spec.args;
      if (!Array.isArray(args) || !args.every((entry) => typeof entry === "string")) {
        throw new FizzySymphonyError("WORKSPACE_HOOK_INVALID", "Workspace hook args must be a list of strings.", { spec });
      }
      return [[spec.command, ...args]];
    }
  }
  throw new FizzySymphonyError("WORKSPACE_HOOK_INVALID", "Workspace hook must be a command string, argv list, or command object.", { spec });
}

function singleStringCommand(value) {
  const command = String(value).trim();
  if (!command || /\s/u.test(command)) {
    throw new FizzySymphonyError("WORKSPACE_HOOK_INVALID", "String workspace hooks must name one executable without shell syntax.", {
      hook: value
    });
  }
  return [command];
}

async function runHookCommand(argv, { cwd } = {}) {
  const [file, ...args] = argv;
  try {
    const raw = await execFileAsync(file, args, { cwd });
    return normalizeCommandResult(raw);
  } catch (error) {
    const result = normalizeCommandError(error);
    throw new FizzySymphonyError("WORKSPACE_HOOK_FAILED", "Workspace lifecycle hook failed.", {
      cwd,
      argv,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      cause: error.message
    });
  }
}

function normalizeCommandResult(result = {}) {
  if (typeof result === "string") return { stdout: result, stderr: "", exit_code: 0 };
  const normalized = {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    exit_code: Number(result.exit_code ?? result.code ?? 0)
  };
  if (normalized.exit_code !== 0) {
    throw new FizzySymphonyError("WORKSPACE_HOOK_FAILED", "Workspace lifecycle hook failed.", normalized);
  }
  return normalized;
}

function normalizeCommandError(error = {}) {
  return {
    stdout: String(error.stdout ?? ""),
    stderr: String(error.stderr ?? error.message ?? ""),
    exit_code: Number(error.exit_code ?? error.code ?? 1)
  };
}

function logCardProgress(logger, event, { card = {}, route = {}, workspace, run, error } = {}) {
  if (!logger) return;
  const fields = {
    message: progressMessage(event, { card, route, workspace, error }),
    card_id: card.id,
    card_number: card.number ?? card.card_number,
    card_title: card.title,
    board_id: card.board_id ?? route.board_id,
    route_id: route.id,
    source_column_name: route.source_column_name,
    completion: route.completion,
    workspace_path: workspace?.path,
    run_id: run?.id
  };
  if (error) fields.error = normalizeError(error);
  const level = event === "card.dispatch_failed" ? "error" : "info";
  logger[level]?.(event, omitUndefined(fields));
}

function progressMessage(event, { card = {}, route = {}, workspace, error } = {}) {
  const cardLabel = formatCardLabel(card);
  if (event === "card.dispatch_started") {
    return `Dispatching ${cardLabel} from ${route.source_column_name ?? route.source_column_id ?? "routed column"}.`;
  }
  if (event === "card.workspace_prepared") {
    return `Workspace ready for ${cardLabel}${workspace?.path ? ` at ${workspace.path}` : ""}.`;
  }
  if (event === "card.runner_started") return `Runner started for ${cardLabel}.`;
  if (event === "card.runner_completed") return `Runner finished for ${cardLabel}; applying Fizzy completion.`;
  if (event === "card.dispatch_completed") return `Completed ${cardLabel} -> ${completionLabel(route)}.`;
  if (event === "card.dispatch_failed") return `Failed ${cardLabel}: ${error?.message ?? "unknown error"}`;
  return cardLabel;
}

function formatCardLabel(card = {}) {
  const number = card.number ?? card.card_number;
  const title = card.title ?? card.name ?? card.id ?? "card";
  return `${number ? `#${number} ` : ""}${title}`;
}

function completionLabel(route = {}) {
  const completion = route.completion ?? {};
  if (completion.policy === "move_to_column") return completion.target_column_name ?? completion.target_column_id ?? "target column";
  if (completion.policy === "comment_once") return "result comment";
  return completion.policy ?? "complete";
}

async function consumeRerunSignal({ status, fizzy, card, route, decision, now }) {
  const record = {
    card_id: card.id,
    route_id: route?.id,
    route_fingerprint: route?.fingerprint,
    consumed_at: now,
    tag: "agent-rerun"
  };
  status?.recordRerunConsumption?.(record);
  if (fizzy?.removeTag) {
    await fizzy.removeTag({ card, tag: "agent-rerun", route, decision });
    return { ...record, removed: true };
  }
  return { ...record, removed: false };
}

function durableProofReference({ config = {}, run = {} }) {
  const stateDir = config.observability?.state_dir ?? ".fizzy-symphony/run";
  const runId = run.id ?? run.run_id ?? "run";
  return {
    file: `${String(stateDir).replace(/\/$/u, "")}/proof/${String(runId).replace(/[^A-Za-z0-9._-]/gu, "_")}.json`
  };
}

async function refreshCardForCompletion({ fizzy, card, route }) {
  if (fizzy?.refreshCard) return fizzy.refreshCard({ card, route });
  if (fizzy?.getCard) return fizzy.getCard(card.id ?? card.card_id);
  return card;
}

function assertRouteStillCurrent(card, route) {
  const currentFingerprint = card?.current_route_fingerprint ?? card?.route_fingerprint ?? card?.route?.fingerprint;
  if (!currentFingerprint || currentFingerprint === route?.fingerprint) return;

  throw completionFailure("STALE_ROUTE_FINGERPRINT", "Route fingerprint changed before completion; preserving workspace.", {
    route_id: route?.id,
    expected_route_fingerprint: route?.fingerprint,
    current_route_fingerprint: currentFingerprint,
    preserve_workspace: true
  });
}

async function recordRunnerFailureMarker({ config, fizzy, run, card, route, workspace, error, now }) {
  if (!workspace) return null;

  const marker = createCompletionFailureMarker({
    run,
    card,
    route,
    instance: config.instance,
    workspace,
    reason: error?.message ?? "Runner failed.",
    createdAt: now
  });

  try {
    return await recordCompletionFailureMarker({
      fizzy,
      run,
      card,
      route,
      workspace,
      result: null,
      marker
    });
  } catch (markerError) {
    return {
      ...marker,
      status: "failed",
      marker_error: normalizeError(markerError)
    };
  }
}

async function recordCompletionMarker({ fizzy, marker, ...context }) {
  const response = fizzy?.recordCompletionMarker
    ? await fizzy.recordCompletionMarker({ ...context, marker, body: marker.body, tag: marker.tag, payload: marker.payload })
    : null;
  return { ...marker, ...(response ?? {}) };
}

async function recordCompletionFailureMarker({ fizzy, marker, ...context }) {
  const response = fizzy?.recordCompletionFailureMarker
    ? await fizzy.recordCompletionFailureMarker({ ...context, marker, body: marker.body, tag: marker.tag, payload: marker.payload })
    : null;
  return { ...marker, ...(response ?? {}) };
}

function completionFailure(code, message, details = {}) {
  const error = new Error(message);
  error.code = code ?? "COMPLETION_POLICY_FAILED";
  error.details = details;
  return error;
}

function normalizeStepForError(step) {
  if (typeof step === "string") return { id: null, title: step };
  return {
    id: step?.id ?? step?.step_id ?? null,
    title: step?.title ?? step?.name ?? step?.text ?? step?.description ?? step?.body ?? ""
  };
}

async function writeRunAttempt(status, run, runStatus) {
  if (!status?.writeRunAttemptRecord) return null;
  return status.writeRunAttemptRecord({ ...run, status: runStatus });
}

function workflowSummary(workflow) {
  if (!workflow) return null;
  return {
    front_matter: workflow.front_matter ?? workflow.frontMatter ?? {},
    body_length: String(workflow.body ?? "").length
  };
}

function renderRunPrompt({ workflow, card, route, workspace, workpad, claim, config, attempt }) {
  return renderPrompt({
    workflow,
    board: {
      id: card?.board_id ?? route?.board_id,
      name: card?.board?.name ?? route?.board_name
    },
    column: {
      id: card?.column_id ?? route?.source_column_id,
      name: card?.column?.name ?? route?.source_column_name
    },
    route,
    card,
    attempt,
    workspace: {
      id: workspace?.key ?? workspace?.workspace_key,
      path: workspace?.path ?? workspace?.workspace_path,
      source_repo: workspace?.source_repo ?? workspace?.sourceRepo,
      branch: workspace?.branch_name ?? workspace?.branch,
      metadata_path: workspace?.metadata_path
    },
    workpad,
    completion: {
      daemon_policy: config?.completion ?? {},
      claim: {
        claim_id: claim?.claim_id ?? claim?.id,
        attempt_id: claim?.attempt_id ?? claim?.attemptId,
        run_id: claim?.run_id ?? claim?.runId
      }
    }
  });
}

function runnerFailure(result) {
  const error = new Error(result?.error?.message ?? `Runner turn did not complete: ${result?.status ?? "unknown"}`);
  error.code = result?.error?.code ?? "RUNNER_TURN_FAILED";
  error.details = { result };
  return error;
}

function isRetryableRunnerError(error = {}) {
  return !String(error.code ?? "").startsWith("COMPLETION_") &&
    error.code !== "STALE_ROUTE_FINGERPRINT" &&
    error.code !== "RUN_CANCELLED";
}

function cleanupStatusName(cleanup = {}) {
  if (cleanup.status) return cleanup.status;
  if (cleanup.action === "removed") return "cleanup_completed";
  if (cleanup.action === "eligible") return "cleanup_planned";
  return "cleanup_preserved";
}

async function withOptionalTimeout(promise, timeoutMs) {
  if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0) {
    return promise;
  }

  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ timeout: true }), Number(timeoutMs));
        timeout.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeError(error = {}) {
  if (typeof error === "string") return { code: "ERROR", message: error };
  return {
    code: error.code ?? "ERROR",
    message: error.message ?? String(error),
    details: error.details ?? {}
  };
}

function currentIso(now) {
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function omitUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}
