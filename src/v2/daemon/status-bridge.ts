import { normalizeStatus } from "../core/status.ts";
import type {
  CardRuntimeState,
  ClaimState,
  RunState,
  SymphonyStatus
} from "../core/types.ts";

export function projectV1StatusToV2(snapshot: Record<string, any> = {}): SymphonyStatus {
  const routes = (snapshot.routes ?? []).map(projectRoute(snapshot));
  const runs = {
    queued: projectRuns(snapshot.runs?.queued, "queued"),
    running: projectRuns(snapshot.runs?.running ?? snapshot.active_runs, "running"),
    completed: projectRuns(snapshot.runs?.completed, "completed"),
    failed: projectRuns(snapshot.runs?.failed, "failed"),
    cancelled: projectRuns(snapshot.runs?.cancelled, "cancelled"),
    preempted: projectRuns(snapshot.runs?.preempted, "preempted")
  };
  const cards = uniqueById([
    ...routes
      .filter((route) => route.goldenCardId)
      .map((route) => ({
        id: String(route.goldenCardId),
        number: route.goldenCardNumber,
        title: "Agent instructions (golden ticket)",
        boardId: route.boardId,
        routeId: route.id,
        columnId: route.sourceColumnId,
        columnName: route.sourceColumnName,
        state: "idle" as CardRuntimeState,
        golden: true
      })),
    ...Object.values(runs)
      .flat()
      .filter((run) => run.cardId)
      .map((run) => ({
        id: String(run.cardId),
        number: run.cardNumber,
        title: run.cardTitle ?? cardTitle(run),
        boardId: run.boardId ?? "unknown",
        routeId: run.routeId,
        state: cardStateForRun(run.state),
        golden: false,
        runId: run.id,
        claimId: run.claimId,
        workspacePath: run.workspacePath,
        attention: run.error?.message
      }))
  ]);
  const worktrees = projectWorktrees(snapshot, runs);
  const failedRuns = [...runs.failed, ...runs.cancelled.filter((run) => run.error)];
  const doctorBlockers = [
    ...worktrees
      .filter((worktree) => worktree.preserved || worktree.dirty)
      .map((worktree) => ({
        code: worktree.dirty ? "WORKTREE_DIRTY" : "WORKTREE_PRESERVED",
        message: worktree.dirty
          ? `Worktree ${worktree.workspaceKey} has uncommitted changes.`
          : `Worktree ${worktree.workspaceKey} is preserved for inspection.`,
        workspaceKey: worktree.workspaceKey,
        recommendedAction: worktree.recommendedAction
      })),
    ...failedRuns.map((run) => ({
      code: "RUN_FAILED",
      message: `Run ${run.id} failed or needs triage.`,
      recommendedAction: run.recommendedAction
    }))
  ];

  return normalizeStatus({
    instance: {
      id: snapshot.instance?.id ?? snapshot.instance_id ?? "unknown",
      label: snapshot.instance?.label,
      pid: snapshot.instance?.pid ?? snapshot.pid ?? null,
      startedAt: snapshot.instance?.started_at ?? snapshot.started_at ?? null,
      endpoint: endpointUrl(snapshot.instance?.endpoint ?? snapshot.endpoint),
      daemonVersion: snapshot.daemon_version
    },
    readiness: {
      state: readinessState(snapshot.readiness),
      ready: snapshot.readiness?.ready === true,
      blockers: (snapshot.readiness?.blockers ?? []).map((blocker: Record<string, any>) => ({
        code: blocker.code ?? "READINESS_BLOCKER",
        message: blocker.message ?? "Readiness blocker.",
        detail: blocker
      })),
      dispatchPaused: snapshot.readiness?.checks?.dispatch_enabled === false,
      runnerStatus: snapshot.runner_health?.status ?? snapshot.readiness?.runner_health?.status
    },
    boards: projectBoards(snapshot, routes, cards),
    routes,
    cards,
    runs,
    claims: (snapshot.claims ?? snapshot.lifecycle?.claims ?? []).map(projectClaim),
    worktrees,
    retryQueue: (snapshot.retry_queue ?? []).map((item: Record<string, any>) => ({
      runId: String(item.run_id ?? item.runId ?? ""),
      cardId: item.card_id ?? item.cardId,
      attempt: Number(item.attempt ?? item.attempt_number ?? 1),
      maxAttempts: item.max_attempts ?? item.maxAttempts,
      nextRetryAt: item.next_retry_at ?? item.nextRetryAt ?? item.next_attempt_at,
      reason: item.reason
    })),
    capacityRefusals: (snapshot.capacity_refusals ?? []).map((refusal: Record<string, any>) => ({
      cardId: refusal.card_id ?? refusal.cardId,
      routeId: refusal.route_id ?? refusal.routeId,
      reason: refusal.reason ?? "capacity refused",
      refusedAt: refusal.refused_at ?? refusal.refusedAt
    })),
    doctor: {
      goalClosable: doctorBlockers.length === 0,
      blockers: doctorBlockers,
      checkedAt: snapshot.last_updated_at
    },
    warnings: (snapshot.recent_warnings ?? []).map((warning: Record<string, any>) => ({
      code: warning.code ?? "RUNTIME_WARNING",
      message: warning.message ?? "Runtime warning.",
      severity: warning.severity ?? "warning",
      at: warning.recorded_at ?? warning.at,
      cardId: warning.card_id ?? warning.cardId,
      runId: warning.run_id ?? warning.runId
    })),
    recentEvents: projectEvents(snapshot),
    lastUpdatedAt: snapshot.last_updated_at ?? new Date(0).toISOString()
  });
}

function projectRoute(snapshot: Record<string, any>) {
  const runnerStatus = snapshot.runner_health?.status ?? snapshot.readiness?.runner_health?.status;
  return (route: Record<string, any>) => ({
    id: String(route.id ?? route.route_id ?? ""),
    boardId: String(route.board_id ?? route.boardId ?? ""),
    name: route.name ?? route.source_column_name ?? route.sourceColumnName ?? route.source_column_id ?? route.sourceColumnId ?? "Route",
    sourceColumnId: route.source_column_id ?? route.sourceColumnId,
    sourceColumnName: route.source_column_name ?? route.sourceColumnName,
    goldenCardId: route.golden_card_id ?? route.goldenCardId,
    goldenCardNumber: route.golden_card_number ?? route.goldenCardNumber,
    backend: route.backend,
    model: route.model,
    enabled: route.enabled === undefined ? runnerStatus !== "unavailable" : Boolean(route.enabled),
    disabledReason: route.enabled === false
      ? route.disabledReason ?? "Route disabled"
      : runnerStatus === "unavailable" ? "Runner unavailable" : undefined
  });
}

function projectBoards(snapshot: Record<string, any>, routes: SymphonyStatus["routes"], cards: SymphonyStatus["cards"]) {
  const watched = snapshot.watched_boards ?? [];
  const boardIds = new Set([
    ...watched.map((board: Record<string, any>) => board.id),
    ...routes.map((route) => route.boardId),
    ...cards.map((card) => card.boardId)
  ].filter(Boolean));
  return [...boardIds].map((id) => {
    const watchedBoard = watched.find((board: Record<string, any>) => board.id === id) ?? {};
    return {
      id: String(id),
      name: String(watchedBoard.label ?? watchedBoard.name ?? id),
      routeIds: routes.filter((route) => route.boardId === id).map((route) => route.id),
      activeCardCount: cards.filter((card) => card.boardId === id && !card.golden).length,
      goldenCardCount: cards.filter((card) => card.boardId === id && card.golden).length
    };
  });
}

function projectRuns(value: Record<string, any>[] | undefined, state: RunState) {
  return (value ?? []).map((run) => ({
    id: String(run.id ?? run.run_id ?? ""),
    attemptId: run.attempt_id ?? run.attemptId,
    state,
    boardId: run.board_id ?? run.boardId,
    cardId: run.card_id ?? run.cardId,
    cardNumber: run.card_number ?? run.cardNumber,
    cardTitle: run.card_title ?? run.cardTitle ?? run.card?.title,
    routeId: run.route_id ?? run.routeId,
    claimId: run.claim_id ?? run.claimId,
    sessionId: run.session_id ?? run.sessionId,
    turnId: run.turn_id ?? run.turnId,
    workspacePath: run.workspace_path ?? run.workspacePath,
    startedAt: run.started_at ?? run.startedAt,
    updatedAt: run.updated_at ?? run.updatedAt,
    stalled: run.stalled === true,
    error: projectError(run.last_error ?? run.error),
    recommendedAction: run.recommended_action ?? run.recommendedAction
  }));
}

function projectClaim(claim: Record<string, any>) {
  return {
    id: String(claim.id ?? claim.claim_id ?? ""),
    cardId: claim.card_id ?? claim.cardId,
    boardId: claim.board_id ?? claim.boardId,
    routeId: claim.route_id ?? claim.routeId,
    runId: claim.run_id ?? claim.runId,
    state: claimState(claim.status ?? claim.state),
    expiresAt: claim.expires_at ?? claim.expiresAt,
    workspaceKey: claim.workspace_key ?? claim.workspaceKey
  };
}

function projectWorktrees(snapshot: Record<string, any>, runs: SymphonyStatus["runs"]) {
  const byKey = new Map<string, any>();
  for (const run of Object.values(runs).flat()) {
    if (!run.workspacePath) continue;
    byKey.set(run.claimId ?? run.id, {
      workspaceKey: run.claimId ?? run.id,
      path: run.workspacePath,
      cardId: run.cardId,
      cardNumber: run.cardNumber,
      runId: run.id,
      dirty: false,
      preserved: false,
      lastError: run.error,
      recommendedAction: run.recommendedAction
    });
  }
  for (const preserved of [
    ...(snapshot.startup_recovery?.preserved_workspaces ?? []),
    ...(snapshot.recovery_report?.preserved_workspaces ?? [])
  ]) {
    const key = String(preserved.workspace_key ?? preserved.workspaceKey ?? preserved.attempt_id ?? preserved.run_id ?? "workspace");
    byKey.set(key, {
      ...(byKey.get(key) ?? {}),
      workspaceKey: key,
      path: preserved.workspace_path ?? preserved.path ?? byKey.get(key)?.path ?? "",
      dirty: preserved.dirty === true,
      preserved: true,
      lastError: projectError(preserved.error),
      recommendedAction: preserved.recommended_action ?? preserved.recommendedAction ?? "inspect"
    });
  }
  const cleanup = snapshot.cleanup_state ?? snapshot.workspace_cleanup_state;
  if (cleanup?.status === "preserved" && (cleanup.workspace_path || cleanup.workspace_key)) {
    const key = String(cleanup.workspace_key ?? cleanup.workspaceKey ?? cleanup.run_id ?? cleanup.workspace_path);
    byKey.set(key, {
      ...(byKey.get(key) ?? {}),
      workspaceKey: key,
      path: cleanup.workspace_path ?? cleanup.workspacePath ?? byKey.get(key)?.path ?? "",
      dirty: cleanup.dirty === true,
      preserved: true,
      lastError: projectError(cleanup.error ?? (cleanup.reason ? { code: "WORKSPACE_PRESERVED", message: cleanup.reason } : undefined)),
      recommendedAction: cleanup.recommended_action ?? cleanup.recommendedAction ?? "inspect"
    });
  }
  return [...byKey.values()].filter((worktree) => worktree.path);
}

function projectEvents(snapshot: Record<string, any>) {
  return [
    ...(snapshot.recent_failures ?? []).map((failure: Record<string, any>, index: number) => ({
      id: `failure_${index}`,
      type: "v1.recent_failure",
      severity: "error",
      message: failure.error?.message ?? "Recent run failure.",
      at: failure.failed_at ?? snapshot.last_updated_at ?? new Date(0).toISOString(),
      cardId: failure.card_id ?? failure.cardId,
      runId: failure.run_id ?? failure.runId,
      data: failure
    })),
    ...(snapshot.recent_warnings ?? []).map((warning: Record<string, any>, index: number) => ({
      id: `warning_${index}`,
      type: "v1.recent_warning",
      severity: warning.severity ?? "warning",
      message: warning.message ?? "Runtime warning.",
      at: warning.recorded_at ?? warning.at ?? snapshot.last_updated_at ?? new Date(0).toISOString(),
      cardId: warning.card_id ?? warning.cardId,
      runId: warning.run_id ?? warning.runId,
      data: warning
    }))
  ];
}

function endpointUrl(endpoint: any): string | null {
  if (!endpoint) return null;
  if (typeof endpoint === "string") return endpoint;
  return endpoint.base_url ?? endpoint.baseUrl ?? (endpoint.host && endpoint.port ? `http://${endpoint.host}:${endpoint.port}` : null);
}

function readinessState(readiness: Record<string, any> = {}) {
  if (readiness.checks?.dispatch_enabled === false) return "locked";
  if (readiness.ready === true) return "ready";
  return "blocked";
}

function cardStateForRun(state: RunState): CardRuntimeState {
  if (state === "preempted") return "cancelled";
  return state;
}

function cardTitle(run: Record<string, any>) {
  return run.cardNumber ? `Card #${run.cardNumber}` : String(run.cardId ?? run.id);
}

function claimState(value: string): ClaimState {
  const normalized = String(value ?? "claimed");
  if (["claimed", "renewed", "released", "completed", "failed", "cancelled", "lost"].includes(normalized)) {
    return normalized as ClaimState;
  }
  return "claimed";
}

function projectError(error: Record<string, any> | undefined) {
  if (!error) return undefined;
  return {
    code: error.code ?? "ERROR",
    message: error.message ?? String(error),
    remediation: error.remediation
  };
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const seen = new Map<string, T>();
  for (const value of values) {
    if (!seen.has(value.id)) seen.set(value.id, value);
  }
  return [...seen.values()];
}
