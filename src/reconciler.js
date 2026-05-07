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
import { cardBoardId, cardColumnId, cardStatus } from "./fizzy-normalize.js";
import { renderPrompt } from "./workflow.js";

const MAX_LOGGED_DIRTY_PATHS = 10;

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
    const candidates = normalizeCandidates(candidatesResult);
    result.discovered = candidates.length;
    recordEtagStats(status, candidatesResult, fizzy);

    if (config.diagnostics?.no_dispatch) {
      result.ignored += candidates.length;
      recordLifecycle(status, orchestratorState);
      status?.recordPoll?.({ completedAt: startedAt, error: null });
      return result;
    }

    const capacity = createCapacityTracker({ config, status, orchestratorState });

    for (const candidateCard of candidates) {
      const card = await hydrateCardForRouting({ fizzy, card: candidateCard });
      if (reconciled.card_ids.has(card.id)) {
        result.ignored += 1;
        continue;
      }

      const decision = await router.validateCandidate({ config, card, status });
      if (decision?.action !== "spawn" && decision?.spawn !== true) {
        result.ignored += 1;
        continue;
      }

      const capacityRefusal = capacity.refusalFor({ card, route: decision.route, at: startedAt });
      if (capacityRefusal) {
        status?.recordCapacityRefusal?.(capacityRefusal);
        result.capacity_refused += 1;
        result.ignored += 1;
        continue;
      }

      const workspaceIdentity = await resolveWorkspaceIdentity({ config, card, decision, workspaceManager });
      await workspaceManager?.preflight?.({
        config,
        card,
        route: decision.route,
        decision,
        identity: workspaceIdentity,
        workspace: workspaceIdentity
      });
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
      dirty_source_repo_policy: config.safety?.dirty_source_repo_policy ?? "fail",
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
    const release = await claims?.release?.({ config, claim: run.claim, run, status: "cancelled", now, reason });
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
    const turn = await runner.startTurn(session, prompt, { run_id: runId, card_id: card.id, route_id: route?.id });
    run = status?.startRun?.({ ...run, turn }) ?? { ...run, turn };
    await writeRunAttempt(status, run, "running");
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

    const streamResult = await runner.stream(turn, (event) => {
      status?.recordRunnerEvent?.(runId, event);
      orchestratorState?.recordRunnerActivity?.(runId, event);
    });

    if (streamResult?.status !== "completed") {
      throw runnerFailure(streamResult);
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
      await claims.release({ config, claim, run: failed ?? run, status: "failed", now, error, completion_marker: recordedFailureMarker });
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
      await claims.release({ config, claim, run: failed ?? run, status: "failed", now, error, completion_marker: recordedFailureMarker });
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

    const claimRelease = await claims.release({ config, claim, run: completed ?? run, status: "completed", now });
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
      claim,
      run: failed ?? run,
      status: "failed",
      now,
      error,
      completion_marker: failureMarker ?? undefined
    });
    return { status: "failed", run: failed ?? run, error };
  }
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
