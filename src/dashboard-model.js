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
    failures: snapshot.recent_failures ?? [],
    completions: snapshot.recent_completions ?? []
  };
}

export function renderDashboardText(model) {
  return [
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
  ].join("\n");
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}
