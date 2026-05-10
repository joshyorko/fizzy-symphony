export function createDashboardModel(snapshot = {}, source = {}) {
  const readiness = snapshot.readiness ?? {};
  const runnerHealth = snapshot.runner_health ?? {};
  const webhook = snapshot.webhook ?? {};
  const managedWebhooks = snapshot.managed_webhooks ?? {};
  const instance = snapshot.instance ?? {};
  const endpoint = snapshot.endpoint?.base_url ?? source.endpoint ?? "unknown";
  const boards = snapshot.watched_boards ?? [];
  const routes = snapshot.routes ?? [];
  const activeRuns = snapshot.active_runs ?? [];
  const blockers = readiness.blockers ?? [];
  const failures = snapshot.recent_failures ?? [];
  const completions = snapshot.recent_completions ?? [];
  const capacityRefusals = snapshot.capacity_refusals ?? [];
  const runtimeWarnings = snapshot.recent_warnings ?? [];
  const workpadFailures = snapshot.workpad_failures ?? [];
  const webhookErrors = webhook.recent_delivery_errors ?? managedWebhooks.recent_delivery_errors ?? [];
  const validationWarnings = snapshot.validation?.warnings ?? [];
  const validationErrors = snapshot.validation?.errors ?? [];
  const counts = {
    boards: count(boards),
    routes: count(routes),
    activeRuns: count(activeRuns),
    claims: count(snapshot.claims),
    workpads: count(snapshot.workpads),
    retryQueue: count(snapshot.retry_queue),
    failures: count(failures),
    completions: count(completions),
    webhookErrors: count(webhookErrors),
    capacityRefusals: count(capacityRefusals),
    validationWarnings: count(validationWarnings),
    validationErrors: count(validationErrors),
    runtimeWarnings: count(runtimeWarnings),
    workpadFailures: count(workpadFailures)
  };
  const runner = {
    kind: runnerHealth.kind ?? snapshot.runner?.kind ?? "unknown",
    status: runnerHealth.status ?? "unknown",
    reason: runnerHealth.reason ?? "",
    label: `${runnerHealth.kind ?? snapshot.runner?.kind ?? "unknown"} ${runnerHealth.status ?? "unknown"}`
  };
  const readinessModel = {
    ready: Boolean(readiness.ready),
    status: readiness.ready ? "ready" : "not ready",
    blockers
  };

  const model = {
    title: "fizzy-symphony operator cockpit",
    instance: {
      id: instance.id ?? "unknown",
      label: instance.label ?? "",
      endpoint
    },
    state: stateFor(readinessModel, counts),
    readiness: readinessModel,
    runner,
    counts,
    metrics: metricsFor(counts),
    webhook: {
      enabled: Boolean(webhook.enabled),
      status: webhook.management?.status ?? (managedWebhooks.enabled ? "managed" : "unmanaged"),
      errors: webhookErrors
    },
    cleanup: {
      status: snapshot.cleanup_state?.status ?? snapshot.workspace_cleanup_state?.status ?? "unknown"
    },
    updatedAt: snapshot.last_updated_at ?? snapshot.updated_at ?? "",
    boards,
    routes,
    activeRuns,
    workspacePaths: snapshot.workspace_paths ?? workspacePaths(activeRuns),
    failures,
    completions,
    capacityRefusals,
    runtimeWarnings,
    workpadFailures,
    validation: {
      warnings: validationWarnings,
      errors: validationErrors
    }
  };

  model.sections = sectionsFor(model);
  return model;
}

export function renderDashboardText(model) {
  const lines = [
    model.title,
    "Command: fizzy-symphony dashboard",
    "",
    `State: ${model.state.label} - ${model.state.detail}`,
    `Instance: ${formatInstance(model.instance)}`,
    `Endpoint: ${model.instance.endpoint}`,
    `Runner: ${model.runner.label}`,
    `Cleanup: ${model.cleanup.status}`,
    ...(model.updatedAt ? [`Updated: ${model.updatedAt}`] : []),
    "",
    "Counters",
    ...model.metrics.map((metric) => `- ${metric.label}: ${metric.value}`)
  ];

  appendGroupedSection(lines, "Board workflow", model.sections.boardWorkflow, "No watched boards or golden-ticket routes reported.");
  appendSection(lines, "Active work", model.sections.activeWork, "No active work is running.");
  appendSection(lines, "Worktrees", model.sections.worktrees, "No active worktree paths reported.");
  appendSection(lines, "Recent activity", model.sections.recentActivity, "No recent completions or runtime warnings reported.");
  appendSection(lines, "Failures and blockers", model.sections.failures, "No readiness blockers or recent failures reported.");
  lines.push(
    "",
    "Footer",
    `- Source: ${statusSource(model.instance.endpoint)}`,
    "- Controls: q, Esc, or Ctrl-C exits the live dashboard."
  );

  return lines.join("\n");
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function stateFor(readiness, counts) {
  const ready = readiness.ready === true;
  const running = counts.activeRuns > 0;
  const blockers = count(readiness.blockers);
  const label = ready ? (running ? "RUNNING" : "READY") : "BLOCKED";
  const detail = [
    plural(counts.activeRuns, "active run"),
    blockers === 0 ? "no readiness blockers" : plural(blockers, "readiness blocker")
  ].join(", ");
  return {
    label,
    ready,
    running,
    blocked: !ready,
    detail
  };
}

function metricsFor(counts) {
  return [
    { label: "Boards", value: counts.boards },
    { label: "Routes", value: counts.routes },
    { label: "Active runs", value: counts.activeRuns },
    { label: "Claims", value: counts.claims },
    { label: "Workpads", value: counts.workpads },
    { label: "Retry queue", value: counts.retryQueue },
    { label: "Recent completions", value: counts.completions },
    { label: "Recent failures", value: counts.failures },
    { label: "Webhook errors", value: counts.webhookErrors },
    { label: "Capacity refusals", value: counts.capacityRefusals },
    { label: "Runtime warnings", value: counts.runtimeWarnings },
    { label: "Workpad failures", value: counts.workpadFailures },
    { label: "Validation warnings", value: counts.validationWarnings },
    { label: "Validation errors", value: counts.validationErrors }
  ];
}

function sectionsFor(model) {
  return {
    boardWorkflow: formatBoardWorkflow(model.boards, model.routes),
    activeWork: model.activeRuns.map(formatRun),
    worktrees: model.workspacePaths,
    recentActivity: [
      ...latest(model.completions).map(formatCompletion),
      ...latest(model.runtimeWarnings).map(formatRuntimeWarning)
    ],
    failures: [
      ...model.readiness.blockers.map(formatBlocker),
      ...latest(model.failures).map(formatFailure),
      ...latest(model.webhook.errors).map(formatWebhookError),
      ...latest(model.workpadFailures).map(formatWorkpadFailure),
      ...latest(model.capacityRefusals).map(formatCapacityRefusal),
      ...latest(model.validation.errors).map(formatValidationError)
    ]
  };
}

function appendSection(lines, title, rows = [], emptyText = "") {
  const visible = rows.filter(Boolean).slice(0, 5);
  lines.push("", title);
  if (visible.length === 0) {
    if (emptyText) lines.push(`- ${emptyText}`);
    return;
  }
  for (const row of visible) lines.push(`- ${row}`);
  if (rows.length > visible.length) lines.push(`- ... ${rows.length - visible.length} more`);
}

function appendGroupedSection(lines, title, groups = [], emptyText = "") {
  lines.push("", title);
  const visible = groups.filter(Boolean).slice(0, 5);
  if (visible.length === 0) {
    if (emptyText) lines.push(`- ${emptyText}`);
    return;
  }
  for (const group of visible) {
    lines.push(`- ${group.title}`);
    for (const row of group.rows.slice(0, 5)) lines.push(`  - ${row}`);
    if (group.rows.length > 5) lines.push(`  - ... ${group.rows.length - 5} more`);
  }
  if (groups.length > visible.length) lines.push(`- ... ${groups.length - visible.length} more`);
}

function workspacePaths(runs = []) {
  return unique((runs ?? [])
    .map((run) => run.workspace_path ?? run.workspace?.path)
    .filter(Boolean));
}

function formatBoardWorkflow(boards = [], routes = []) {
  const groups = [];
  const boardMap = new Map();
  for (const board of boards) {
    const id = board.id ?? board.board_id;
    if (!id) continue;
    boardMap.set(id, board);
  }

  for (const route of routes) {
    const boardId = route.board_id ?? route.board?.id ?? "unknown";
    if (!boardMap.has(boardId)) {
      boardMap.set(boardId, { id: boardId, label: route.board_name ?? route.board?.name ?? "Unlisted board" });
    }
  }

  for (const board of boardMap.values()) {
    const id = board.id ?? board.board_id ?? "unknown";
    const boardRoutes = routes.filter((route) => (route.board_id ?? route.board?.id) === id);
    groups.push({
      title: formatBoardTitle(board),
      rows: boardRoutes.length > 0
        ? boardRoutes.map(formatRoute)
        : ["No golden-ticket routes reported for this board."]
    });
  }

  return groups;
}

function formatBlocker(blocker = {}) {
  return `${blocker.code ?? "BLOCKED"}${blocker.message ? `: ${blocker.message}` : ""}`;
}

function formatRun(run = {}) {
  const id = run.id ?? run.run_id ?? "run";
  const cardNumber = run.card_number ?? run.card?.number;
  const title = run.card_title ?? run.card?.title;
  const workspacePath = run.workspace_path ?? run.workspace?.path;
  return [
    id,
    cardNumber ? `#${cardNumber}` : "",
    title ?? "",
    run.status ? `(${run.status})` : "",
    workspacePath ? `-> ${workspacePath}` : ""
  ].filter(Boolean).join(" ");
}

function formatCompletion(completion = {}) {
  const id = completion.run_id ?? completion.id ?? "run";
  const card = formatCardRef(completion);
  const at = completion.completed_at ?? completion.finished_at;
  return `completed ${id}${card ? ` ${card}` : ""}${at ? ` at ${at}` : ""}`;
}

function formatFailure(failure = {}) {
  const code = failure.error?.code ?? failure.code ?? "FAILED";
  const id = failure.run_id ?? failure.id ?? failure.card_id ?? "run";
  const message = failure.error?.message ?? failure.message;
  return `${id}: ${code}${message ? ` - ${message}` : ""}`;
}

function formatCapacityRefusal(refusal = {}) {
  const card = refusal.card_number ? `#${refusal.card_number}` : refusal.card?.number ? `#${refusal.card.number}` : refusal.card_id ?? refusal.card?.id ?? "card";
  const reason = refusal.reason ?? "capacity";
  const scope = refusal.scope ? `${refusal.scope} ` : "";
  const counts = Number.isFinite(refusal.active_count) && Number.isFinite(refusal.limit)
    ? ` (${refusal.active_count}/${refusal.limit})`
    : "";
  return `${card}: ${scope}${reason}${counts}`;
}

function formatRuntimeWarning(warning = {}) {
  const code = warning.code ?? "RUNTIME_WARNING";
  return `warning ${code}${warning.message ? ` - ${warning.message}` : ""}`;
}

function formatWebhookError(error = {}) {
  const code = error.code ?? "WEBHOOK_DELIVERY_FAILED";
  const board = error.board_id ? ` ${error.board_id}` : "";
  return `webhook${board}: ${code}${error.message ? ` - ${error.message}` : ""}`;
}

function formatWorkpadFailure(failure = {}) {
  const code = failure.error?.code ?? failure.code ?? "WORKPAD_UPDATE_FAILED";
  const id = failure.run_id ?? failure.card_id ?? failure.failed_comment_id ?? "workpad";
  const message = failure.error?.message ?? failure.message;
  return `${id}: ${code}${message ? ` - ${message}` : ""}`;
}

function formatValidationError(error = {}) {
  const code = error.code ?? "VALIDATION_ERROR";
  return `validation: ${code}${error.message ? ` - ${error.message}` : ""}`;
}

function formatRoute(route = {}) {
  const source = route.source_column_name ?? route.source_column_id ?? "routed column";
  const completion = route.completion ?? {};
  const target = completion.policy === "move_to_column"
    ? completion.target_column_name ?? completion.target_column_id ?? "target column"
    : completion.policy ?? "completion policy";
  const backend = route.backend ?? route.runner_kind ?? route.runner?.kind;
  return `${source} -> ${target}${backend ? ` (${backend})` : ""}`;
}

function formatBoardTitle(board = {}) {
  const label = board.label ?? board.name ?? board.title ?? board.id ?? "Board";
  return board.id && board.id !== label ? `${label} (${board.id})` : label;
}

function formatCardRef(record = {}) {
  const number = record.card_number ?? record.card?.number;
  if (number) return `#${number}`;
  const id = record.card_id ?? record.card?.id;
  return id ? `(${id})` : "";
}

function formatInstance(instance = {}) {
  return `${instance.id ?? "unknown"}${instance.label ? ` (${instance.label})` : ""}`;
}

function statusSource(endpoint) {
  if (!endpoint || endpoint === "unknown") return "status endpoint unknown";
  return `${String(endpoint).replace(/\/+$/u, "")}/status`;
}

function latest(rows = []) {
  return [...(rows ?? [])].reverse();
}

function plural(value, singular) {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function unique(values = []) {
  return [...new Set(values)];
}
