import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

const HISTORY_LIMIT = 50;
const RUN_ATTEMPT_SCHEMA_VERSION = "fizzy-symphony-run-attempt-v1";
const DEFAULT_WEBHOOK_PATH = "/webhook";

export function createStatusStore(options = {}) {
  const {
    config = {},
    instance = {},
    pid = process.pid,
    startedAt = new Date()
  } = options;

  const started_at = toIso(startedAt);
  const instanceMetadata = {
    id: instance.id ?? config.instance?.id ?? "unknown",
    label: instance.label ?? config.instance?.label ?? "",
    pid,
    started_at,
    endpoint: clone(instance.endpoint ?? endpointFromConfig(config))
  };
  const runBuckets = {
    queued: new Map(),
    running: new Map(),
    completed: new Map(),
    failed: new Map(),
    cancelled: new Map(),
    preempted: new Map()
  };
  const claims = new Map();
  const workpads = new Map();
  const state = {
    config,
    instance: instanceMetadata,
    validation: { warnings: [], errors: [] },
    startup_recovery: { warnings: [], errors: [] },
    recovery_report: {},
    lifecycle: { active_runs: [], claims: [] },
    claim_renewals: [],
    stalled_runs: [],
    cancellations: [],
    runner_health: { status: "unknown", kind: config.runner?.preferred ?? "unknown" },
    routes: [],
    poll: {
      tick_in_progress: false,
      last_started_at: null,
      last_completed_at: null,
      last_error: null
    },
    managed_webhooks: {
      enabled: Boolean(config.webhook?.manage),
      by_board: clone(config.webhook?.managed_webhook_ids_by_board ?? {}),
      recent_delivery_errors: []
    },
    shutdown: null,
    etag_cache: { hits: 0, misses: 0, invalid: 0 },
    retry_queue: [],
    cleanup_state: { status: "not_started" },
    recent_completions: [],
    recent_failures: [],
    recent_warnings: [],
    workpad_failures: [],
    rerun_consumptions: [],
    token_rate_limit: { available: false, reason: "not_recorded" },
    last_updated_at: started_at
  };

  function health() {
    const readiness = ready();
    return {
      live: true,
      status: "live",
      instance_id: state.instance.id,
      pid: state.instance.pid,
      started_at: state.instance.started_at,
      ready: readiness.ready
    };
  }

  function ready() {
    const startupReady = state.validation.errors.length === 0;
    const startupRecoveryReady = (state.startup_recovery.errors ?? []).length === 0;
    const dispatchEnabled = state.config.diagnostics?.no_dispatch !== true;
    const runnerReady = dispatchEnabled ? state.runner_health?.status === "ready" : true;
    const blockers = [];

    if (!startupRecoveryReady) {
      blockers.push({
        code: "STARTUP_RECOVERY_ERRORS",
        message: "Startup recovery has errors.",
        errors: clone(state.startup_recovery.errors)
      });
    }

    if (!startupReady) {
      blockers.push({
        code: "STARTUP_ERRORS",
        message: "Startup validation has errors.",
        errors: clone(state.validation.errors)
      });
    }

    if (!dispatchEnabled) {
      blockers.push({
        code: "DISPATCH_DISABLED",
        message: "diagnostics.no_dispatch is enabled; runner dispatch is disabled."
      });
    }

    if (!runnerReady) {
      blockers.push({
        code: "RUNNER_NOT_READY",
        message: "Runner health is not ready.",
        runner_health: clone(state.runner_health)
      });
    }

    return {
      ready: blockers.length === 0,
      status: blockers.length === 0 ? "ready" : "not_ready",
      checks: {
        startup_recovery: startupRecoveryReady,
        startup: startupReady,
        runner: runnerReady,
        dispatch_enabled: dispatchEnabled
      },
      blockers,
      runner_health: clone(state.runner_health),
      validation: clone(state.validation)
    };
  }

  function status() {
    const readiness = ready();
    const runningRuns = bucketValues(runBuckets.running);
    return {
      schema_version: "fizzy-symphony-status-v1",
      instance: clone(state.instance),
      pid: state.instance.pid,
      endpoint: clone(state.instance.endpoint),
      watched_boards: watchedBoards(state.config),
      poll_interval_ms: state.config.polling?.interval_ms ?? null,
      webhook: webhookStatus(state.config, state.managed_webhooks),
      managed_webhooks: clone(state.managed_webhooks),
      shutdown: clone(state.shutdown),
      etag_cache: clone(state.etag_cache),
      runner: {
        kind: state.runner_health?.kind ?? state.config.runner?.preferred ?? "unknown"
      },
      runner_health: clone(state.runner_health),
      health: health(),
      readiness,
      poll: clone(state.poll),
      routes: clone(state.routes),
      startup_recovery: clone(state.startup_recovery),
      recovery_report: clone(state.recovery_report),
      lifecycle: clone(state.lifecycle),
      claim_renewals: clone(state.claim_renewals),
      stalled_runs: clone(state.stalled_runs),
      cancellations: clone(state.cancellations),
      active_runs: clone(runningRuns),
      runs: {
        queued: bucketValues(runBuckets.queued),
        running: runningRuns,
        completed: bucketValues(runBuckets.completed),
        failed: bucketValues(runBuckets.failed),
        cancelled: bucketValues(runBuckets.cancelled),
        preempted: bucketValues(runBuckets.preempted)
      },
      claims: [...claims.values()].map(clone),
      workpads: [...workpads.values()].map(clone),
      rerun_consumptions: clone(state.rerun_consumptions),
      retry_queue: clone(state.retry_queue),
      cleanup_state: clone(state.cleanup_state),
      workspace_cleanup_state: clone(state.cleanup_state),
      recent_completions: clone(state.recent_completions),
      recent_failures: clone(state.recent_failures),
      recent_warnings: clone(state.recent_warnings),
      workpad_failures: clone(state.workpad_failures),
      workspace_paths: runningRuns
        .map((run) => run.workspace_path ?? run.workspace?.path)
        .filter(Boolean),
      token_rate_limit: clone(state.token_rate_limit),
      validation: clone(state.validation),
      last_updated_at: state.last_updated_at
    };
  }

  async function writeSnapshot(snapshotPath) {
    const body = `${JSON.stringify(status(), null, 2)}\n`;
    const directory = dirname(snapshotPath);
    await mkdir(directory, { recursive: true });
    const tmpPath = join(directory, `.${basename(snapshotPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    await writeFile(tmpPath, body, "utf8");
    await rename(tmpPath, snapshotPath);
    return {
      path: snapshotPath,
      bytes: Buffer.byteLength(body)
    };
  }

  async function writeRunAttemptRecord(runOrId, details = {}) {
    const stateDir = details.state_dir ?? state.config.observability?.state_dir;
    if (!stateDir) return null;

    const run = runFrom(runOrId);
    const normalized = normalizeRun({ ...run, ...details }, { status: details.status ?? run?.status });
    const record = runAttemptRecord(normalized, {
      instance: state.instance,
      updated_at: details.updated_at ?? state.last_updated_at
    });
    const runsDir = join(stateDir, "runs");
    const fileName = `${safeFilePart(record.attempt_id ?? record.run_id)}.json`;
    const recordPath = join(runsDir, fileName);
    const body = `${JSON.stringify(record, null, 2)}\n`;

    await mkdir(runsDir, { recursive: true });
    const tmpPath = join(runsDir, `.${fileName}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    await writeFile(tmpPath, body, "utf8");
    await rename(tmpPath, recordPath);
    return {
      path: recordPath,
      bytes: Buffer.byteLength(body),
      record
    };
  }

  function recordStartupValidation(report = {}) {
    state.validation = {
      warnings: clone(report.warnings ?? []),
      errors: clone(report.errors ?? [])
    };
    touch();
  }

  function recordStartupRecovery(report = {}) {
    state.startup_recovery = {
      warnings: clone(report.warnings ?? []),
      errors: clone(report.errors ?? []),
      ...clone(report)
    };
    touch();
  }

  function recordLifecycleSnapshot(snapshot = {}) {
    state.recovery_report = clone(snapshot.recovery_report ?? state.recovery_report);
    state.lifecycle = {
      active_runs: clone(snapshot.active_runs ?? state.lifecycle.active_runs),
      claims: clone(snapshot.claims ?? state.lifecycle.claims)
    };
    state.claim_renewals = clone(snapshot.claim_renewals ?? state.claim_renewals);
    state.stalled_runs = clone(snapshot.stalled_runs ?? state.stalled_runs);
    state.cancellations = clone(snapshot.cancellations ?? state.cancellations);
    if (snapshot.retry_queue) state.retry_queue = clone(snapshot.retry_queue);
    if (snapshot.recent_failures) {
      state.recent_failures = clone(snapshot.recent_failures);
      trimHistory(state.recent_failures);
    }
    if (snapshot.recent_completions) {
      state.recent_completions = clone(snapshot.recent_completions);
      trimHistory(state.recent_completions);
    }
    touch();
  }

  function updateRunnerHealth(report = {}) {
    state.runner_health = clone(report);
    touch();
  }

  function setRoutes(routes = []) {
    state.routes = clone(routes);
    touch();
  }

  function recordPoll(poll = {}) {
    if (poll.startedAt ?? poll.started_at) {
      state.poll.last_started_at = toIso(poll.startedAt ?? poll.started_at);
      state.poll.tick_in_progress = true;
    }
    if (poll.completedAt ?? poll.completed_at) {
      state.poll.last_completed_at = toIso(poll.completedAt ?? poll.completed_at);
      state.poll.tick_in_progress = false;
    }
    if (poll.error) {
      state.poll.last_error = normalizeError(poll.error);
    } else if (Object.hasOwn(poll, "error")) {
      state.poll.last_error = null;
    }
    if (poll.etag_cache) {
      state.etag_cache = { ...state.etag_cache, ...clone(poll.etag_cache) };
    }
    touch();
  }

  function recordEtagCache(counters = {}) {
    state.etag_cache = { ...state.etag_cache, ...clone(counters) };
    touch();
  }

  function recordManagedWebhookStatus(report = {}) {
    state.managed_webhooks = {
      ...state.managed_webhooks,
      ...clone(report),
      enabled: report.enabled ?? state.managed_webhooks.enabled,
      by_board: clone(report.by_board ?? state.managed_webhooks.by_board),
      recent_delivery_errors: clone(report.recent_delivery_errors ?? state.managed_webhooks.recent_delivery_errors)
    };
    touch();
  }

  function recordTokenRateLimit(metadata = {}) {
    state.token_rate_limit = Object.keys(metadata).length === 0
      ? { available: false, reason: "not_recorded" }
      : clone(metadata);
    touch();
  }

  function recordRetryQueue(queue = []) {
    state.retry_queue = clone(queue);
    touch();
  }

  function recordCleanupState(cleanupState = {}) {
    state.cleanup_state = {
      ...state.cleanup_state,
      ...clone(cleanupState)
    };
    touch();
  }

  function recordShutdown(report = {}) {
    state.shutdown = {
      ...clone(report),
      stopped_at: report.stopped_at ?? new Date().toISOString()
    };
    touch();
  }

  function queueRun(run) {
    return putRun("queued", run, { status: "queued" });
  }

  function startRun(run) {
    const existing = run?.id ? findRun(run.id) : null;
    return putRun("running", { ...(existing ?? {}), ...run }, { status: "running" });
  }

  function completeRun(runOrId, details = {}) {
    const run = runFrom(runOrId);
    if (isCancelled(run)) return clone(run);
    const completed = putRun("completed", { ...run, ...details }, { status: "completed" });
    state.recent_completions.push({
      run_id: completed.id,
      card_id: completed.card_id,
      completed_at: completed.completed_at ?? completed.finished_at ?? state.last_updated_at
    });
    trimHistory(state.recent_completions);
    touch();
    return completed;
  }

  function failRun(runOrId, error = {}) {
    const run = runFrom(runOrId);
    if (isCancelled(run)) return clone(run);
    const failed = putRun("failed", { ...run, last_error: normalizeError(error) }, { status: "failed" });
    state.recent_failures.push({
      run_id: failed.id,
      card_id: failed.card_id,
      error: clone(failed.last_error),
      failed_at: failed.failed_at ?? failed.finished_at ?? state.last_updated_at
    });
    trimHistory(state.recent_failures);
    touch();
    return failed;
  }

  function cancelRun(runOrId, reason = "cancelled", details = {}) {
    const run = runFrom(runOrId);
    const cancellation = typeof reason === "object"
      ? clone(reason)
      : { ...(details.cancellation ?? {}), reason };
    const finalStatus = details.final_status ?? cancellation.final_status ?? "cancelled";
    const bucket = finalStatus === "preempted" ? "preempted" : "cancelled";
    return putRun(bucket, {
      ...run,
      ...details,
      cancellation,
      cancellation_reason: cancellation.reason ?? reason
    }, { status: finalStatus });
  }

  function preemptRun(runOrId, cancellation = {}, details = {}) {
    return cancelRun(runOrId, {
      ...cancellation,
      final_status: "preempted"
    }, { ...details, final_status: "preempted" });
  }

  function recordClaim(claim = {}) {
    const id = claim.id ?? claim.claim_id;
    if (!id) return null;
    const normalized = { ...clone(claim), id };
    claims.set(id, normalized);
    touch();
    return clone(normalized);
  }

  function recordWorkpad(workpad = {}) {
    const id = workpad.id ?? workpad.card_id;
    if (!id) return null;
    const normalized = { ...clone(workpad), id };
    workpads.set(id, normalized);
    touch();
    return clone(normalized);
  }

  function getWorkpad(cardId) {
    const workpad = workpads.get(cardId);
    return workpad ? clone(workpad) : null;
  }

  function recordRuntimeWarning(warning = {}) {
    const normalized = {
      code: warning.code ?? "RUNTIME_WARNING",
      message: warning.message ?? "Runtime warning.",
      ...clone(warning),
      recorded_at: warning.recorded_at ?? new Date().toISOString()
    };
    state.recent_warnings.push(normalized);
    trimHistory(state.recent_warnings);
    touch();
    return clone(normalized);
  }

  function recordWorkpadFailure(failure = {}) {
    const normalized = {
      code: failure.code ?? "WORKPAD_UPDATE_FAILED",
      message: failure.message ?? "Workpad update failed.",
      ...clone(failure),
      occurred_at: failure.occurred_at ?? new Date().toISOString()
    };
    state.workpad_failures.push(normalized);
    trimHistory(state.workpad_failures);
    recordRuntimeWarning({
      code: normalized.code,
      message: normalized.message,
      card_id: normalized.card_id,
      run_id: normalized.run_id,
      failed_comment_id: normalized.failed_comment_id,
      replacement_comment_id: normalized.replacement_comment_id,
      replacement_skipped_reason: normalized.replacement_skipped_reason,
      recorded_at: normalized.occurred_at
    });
    touch();
    return clone(normalized);
  }

  function recordRerunConsumption(consumption = {}) {
    const normalized = clone(consumption);
    state.rerun_consumptions.push(normalized);
    trimHistory(state.rerun_consumptions);
    touch();
    return clone(normalized);
  }

  function recordWarning(warning) {
    state.validation.warnings.push(clone(warning));
    touch();
  }

  function recordError(error) {
    state.validation.errors.push(normalizeError(error));
    touch();
  }

  function recordRunnerEvent(runId, event) {
    const run = findRun(runId);
    if (!run) return null;
    const events = [...(run.runner_events ?? []), clone(event)];
    return putRun(run.status, { ...run, runner_events: events }, { status: run.status });
  }

  function activeRunCount() {
    return runBuckets.running.size;
  }

  function putRun(bucketName, run, defaults = {}) {
    const normalized = normalizeRun(run, defaults);
    if (!normalized.id) {
      throw new Error("run id is required");
    }
    removeRun(normalized.id);
    runBuckets[bucketName].set(normalized.id, normalized);
    touch();
    return clone(normalized);
  }

  function runFrom(runOrId) {
    if (typeof runOrId !== "string") return runOrId;
    return findRun(runOrId) ?? { id: runOrId };
  }

  function findRun(runId) {
    for (const bucket of Object.values(runBuckets)) {
      if (bucket.has(runId)) return bucket.get(runId);
    }
    return null;
  }

  function removeRun(runId) {
    for (const bucket of Object.values(runBuckets)) {
      bucket.delete(runId);
    }
  }

  function touch() {
    state.last_updated_at = new Date().toISOString();
  }

  return {
    health,
    ready,
    status,
    writeSnapshot,
    writeRunAttemptRecord,
    recordStartupValidation,
    recordStartupRecovery,
    recordLifecycleSnapshot,
    updateRunnerHealth,
    setRoutes,
    recordPoll,
    recordEtagCache,
    recordManagedWebhookStatus,
    recordTokenRateLimit,
    recordRetryQueue,
    recordCleanupState,
    recordShutdown,
    queueRun,
    startRun,
    completeRun,
    failRun,
    cancelRun,
    preemptRun,
    recordClaim,
    recordWorkpad,
    getWorkpad,
    recordRuntimeWarning,
    recordWorkpadFailure,
    recordRerunConsumption,
    recordWarning,
    recordError,
    recordRunnerEvent,
    activeRunCount
  };
}

function normalizeRun(run = {}, defaults = {}) {
  const route = run.route ?? {};
  const card = run.card ?? {};
  const claim = run.claim ?? {};
  const workspace = run.workspace ?? {};
  const runner = run.runner ?? {};
  const session = run.session ?? {};
  const turn = run.turn ?? {};
  return omitUndefined({
    ...clone(run),
    id: run.id ?? run.run_id,
    attempt_id: run.attempt_id,
    status: defaults.status ?? run.status,
    card_id: run.card_id ?? card.id,
    card_number: run.card_number ?? card.number,
    board_id: run.board_id ?? card.board_id ?? route.board_id,
    route_id: run.route_id ?? route.id,
    route_fingerprint: run.route_fingerprint ?? route.fingerprint,
    card_digest: run.card_digest ?? card.digest,
    workspace_key: run.workspace_key ?? workspace.key,
    workspace_path: run.workspace_path ?? workspace.path,
    workspace_identity_digest: run.workspace_identity_digest ?? workspace.identity_digest,
    claim_id: run.claim_id ?? claim.id ?? claim.claim_id,
    runner_kind: run.runner_kind ?? runner.kind,
    session_id: run.session_id ?? session.session_id,
    thread_id: run.thread_id ?? session.thread_id,
    turn_id: run.turn_id ?? turn.turn_id,
    proof: run.proof,
    proof_digest: run.proof_digest ?? run.proof?.digest,
    proof_file: run.proof_file ?? run.proof?.file,
    result_comment_id: run.result_comment_id,
    completion_marker: run.completion_marker,
    last_error: run.last_error,
    cancellation: run.cancellation,
    cancellation_reason: run.cancellation_reason,
    cancellation_comment_id: run.cancellation_comment_id,
    cleanup_state: run.cleanup_state,
    started_at: run.started_at,
    updated_at: run.updated_at,
    completed_at: run.completed_at,
    failed_at: run.failed_at,
    cancelled_at: run.cancelled_at
  });
}

function runAttemptRecord(run, metadata = {}) {
  return omitUndefined({
    schema_version: RUN_ATTEMPT_SCHEMA_VERSION,
    instance_id: metadata.instance?.id,
    run_id: run.id,
    attempt_id: run.attempt_id ?? run.id,
    card_id: run.card_id,
    card_number: run.card_number,
    board_id: run.board_id,
    route_id: run.route_id,
    route_fingerprint: run.route_fingerprint,
    card_digest: run.card_digest,
    workspace_identity_digest: run.workspace_identity_digest,
    workspace_path: run.workspace_path,
    claim_id: run.claim_id,
    runner_kind: run.runner_kind,
    thread_id: run.thread_id,
    session_id: run.session_id,
    turn_id: run.turn_id,
    status: run.status,
    started_at: run.started_at,
    updated_at: run.updated_at ?? metadata.updated_at,
    completed_at: run.completed_at,
    failed_at: run.failed_at,
    cancelled_at: run.cancelled_at,
    proof_path: run.proof_path ?? run.proof_file,
    proof_digest: run.proof_digest,
    result_comment_id: run.result_comment_id,
    cleanup_state: run.cleanup_state,
    last_error: run.last_error
  });
}

function watchedBoards(config) {
  return (config.boards?.entries ?? [])
    .filter((entry) => entry.enabled !== false)
    .map((entry) => ({
      id: entry.id,
      label: entry.label ?? entry.name ?? entry.id
    }));
}

function endpointFromConfig(config) {
  if (!config.server) return null;
  return {
    host: config.server.host ?? "127.0.0.1",
    port: config.server.port ?? null,
    base_url: config.server.port ? `http://${config.server.host ?? "127.0.0.1"}:${config.server.port}` : null
  };
}

function webhookStatus(config = {}, managedWebhooks = {}) {
  const webhook = config.webhook ?? {};
  const intakeEnabled = webhook.enabled !== false;
  const managementEnabled = Boolean(webhook.manage);
  const signatureConfigured = Boolean(webhook.secret);

  return {
    enabled: intakeEnabled,
    intake_enabled: intakeEnabled,
    path: webhook.path ?? DEFAULT_WEBHOOK_PATH,
    managed: managementEnabled,
    management: {
      enabled: managementEnabled,
      status: managementEnabled ? "managed" : "unmanaged"
    },
    signature_verification: signatureConfigured
      ? { enabled: true, status: "enabled" }
      : {
          enabled: false,
          status: "disabled",
          reason: "webhook.secret is not configured"
        },
    recent_delivery_errors: clone(managedWebhooks.recent_delivery_errors ?? [])
  };
}

function bucketValues(bucket) {
  return [...bucket.values()].map(clone);
}

function isCancelled(run) {
  return run?.status === "cancelled" || run?.status === "preempted";
}

function normalizeError(error = {}) {
  if (typeof error === "string") {
    return { code: "ERROR", message: error };
  }
  return {
    code: error.code ?? "ERROR",
    message: error.message ?? String(error),
    details: clone(error.details ?? {})
  };
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return value;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function trimHistory(history) {
  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
  }
}

function safeFilePart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/gu, "_");
}
