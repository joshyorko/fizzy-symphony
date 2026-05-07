export function createDashboardModel(snapshot = {}, source = {}) {
  const readiness = snapshot.readiness ?? {};
  const runnerHealth = snapshot.runner_health ?? {};
  const webhook = snapshot.webhook ?? {};
  const managedWebhooks = snapshot.managed_webhooks ?? {};
  const instance = snapshot.instance ?? {};
  const endpoint = snapshot.endpoint?.base_url ?? source.endpoint ?? "unknown";

  return {
    title: "fizzy-symphony dashboard",
    instance: {
      id: instance.id ?? "unknown",
      label: instance.label ?? "",
      endpoint
    },
    readiness: {
      ready: Boolean(readiness.ready),
      status: readiness.ready ? "ready" : "not ready",
      blockers: readiness.blockers ?? []
    },
    runner: {
      kind: runnerHealth.kind ?? snapshot.runner?.kind ?? "unknown",
      status: runnerHealth.status ?? "unknown",
      label: `${runnerHealth.kind ?? snapshot.runner?.kind ?? "unknown"} ${runnerHealth.status ?? "unknown"}`
    },
    counts: {
      boards: count(snapshot.watched_boards),
      routes: count(snapshot.routes),
      activeRuns: count(snapshot.active_runs),
      claims: count(snapshot.claims),
      workpads: count(snapshot.workpads),
      retryQueue: count(snapshot.retry_queue),
      failures: count(snapshot.recent_failures),
      completions: count(snapshot.recent_completions),
      webhookErrors: count(webhook.recent_delivery_errors ?? managedWebhooks.recent_delivery_errors),
      capacityRefusals: count(snapshot.capacity_refusals),
      validationWarnings: count(snapshot.validation?.warnings),
      validationErrors: count(snapshot.validation?.errors)
    },
    webhook: {
      enabled: Boolean(webhook.enabled),
      status: webhook.management?.status ?? (managedWebhooks.enabled ? "managed" : "unmanaged")
    },
    cleanup: {
      status: snapshot.cleanup_state?.status ?? snapshot.workspace_cleanup_state?.status ?? "unknown"
    },
    boards: snapshot.watched_boards ?? [],
    routes: snapshot.routes ?? [],
    activeRuns: snapshot.active_runs ?? [],
    workspacePaths: snapshot.workspace_paths ?? workspacePaths(snapshot.active_runs),
    failures: snapshot.recent_failures ?? [],
    completions: snapshot.recent_completions ?? [],
    capacityRefusals: snapshot.capacity_refusals ?? []
  };
}

export function renderDashboardText(model) {
  const lines = [
    model.title,
    "",
    `Instance: ${model.instance.id}${model.instance.label ? ` (${model.instance.label})` : ""}`,
    `Endpoint: ${model.instance.endpoint}`,
    `Ready: ${model.readiness.ready ? "yes" : "no"}`,
    `Runner: ${model.runner.label}`,
    "",
    `Boards: ${model.counts.boards}`,
    `Routes: ${model.counts.routes}`,
    `Active runs: ${model.counts.activeRuns}`,
    `Claims: ${model.counts.claims}`,
    `Workpads: ${model.counts.workpads}`,
    `Retry queue: ${model.counts.retryQueue}`,
    `Recent completions: ${model.counts.completions}`,
    `Recent failures: ${model.counts.failures}`,
    `Webhook errors: ${model.counts.webhookErrors}`,
    `Capacity refusals: ${model.counts.capacityRefusals}`,
    `Validation warnings: ${model.counts.validationWarnings}`,
    `Validation errors: ${model.counts.validationErrors}`,
    `Cleanup: ${model.cleanup.status}`
  ];

  appendSection(lines, "Blockers", model.readiness.blockers.map(formatBlocker));
  appendSection(lines, "Active", model.activeRuns.map(formatRun));
  appendSection(lines, "Worktrees", model.workspacePaths);
  appendSection(lines, "Recent failures", model.failures.map(formatFailure));
  appendSection(lines, "Capacity refusals", model.capacityRefusals.map(formatCapacityRefusal));

  return lines.join("\n");
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function appendSection(lines, title, rows = []) {
  const visible = rows.filter(Boolean).slice(0, 5);
  if (visible.length === 0) return;
  lines.push("", title);
  for (const row of visible) lines.push(`- ${row}`);
  if (rows.length > visible.length) lines.push(`- ... ${rows.length - visible.length} more`);
}

function workspacePaths(runs = []) {
  return unique((runs ?? [])
    .map((run) => run.workspace_path ?? run.workspace?.path)
    .filter(Boolean));
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

function formatFailure(failure = {}) {
  const code = failure.error?.code ?? failure.code ?? "FAILED";
  const id = failure.run_id ?? failure.id ?? failure.card_id ?? "run";
  return `${id}: ${code}`;
}

function formatCapacityRefusal(refusal = {}) {
  const card = refusal.card?.number ? `#${refusal.card.number}` : refusal.card_id ?? refusal.card?.id ?? "card";
  const reason = refusal.reason ?? "capacity";
  const scope = refusal.scope ? `${refusal.scope} ` : "";
  const counts = Number.isFinite(refusal.active_count) && Number.isFinite(refusal.limit)
    ? ` (${refusal.active_count}/${refusal.limit})`
    : "";
  return `${card}: ${scope}${reason}${counts}`;
}

function unique(values = []) {
  return [...new Set(values)];
}
