import { loadConfig } from "./config.js";
import { FizzySymphonyError } from "./errors.js";
import { startLocalInstance } from "./instance-registry.js";
import { createLocalHttpHandler, createWebhookHintQueue } from "./server.js";
import { createStatusStore } from "./status.js";
import { validateStartup } from "./validation.js";
import { performStartupRecovery } from "./recovery.js";
import { createReconciliationScheduler } from "./scheduler.js";
import { runReconciliationTick } from "./reconciler.js";
import { routeCard } from "./router.js";
import { createBoardClaimStore } from "./claims.js";
import { createOrchestratorState } from "./orchestrator-state.js";
import { loadWorkflow } from "./workflow.js";
import {
  prepareWorkspace,
  resolveWorkspaceIdentity
} from "./workspace.js";
import { createFakeCodexRunner } from "./runner-contract.js";

export async function startDaemon(options = {}) {
  const {
    configPath = ".fizzy-symphony/config.json",
    env = process.env,
    dependencies = {},
    schedulerOptions = {},
    signalProcess = null,
    now = () => new Date()
  } = options;

  const config = await loadConfig(configPath, { env });
  const webhookHints = dependencies.webhookHints ?? createWebhookHintQueue();
  let scheduler = null;
  let status = null;
  const statusProxy = {
    health: () => status?.health?.() ?? { live: true, status: "live", ready: false },
    ready: () => status?.ready?.() ?? { ready: false, status: "not_ready", blockers: [] },
    status: () => status?.status?.() ?? {}
  };

  const requestListener = createLocalHttpHandler({
    config,
    status: statusProxy,
    enqueueWebhookHint: (hint) => scheduler?.enqueueWebhookHint?.(hint) ?? webhookHints.enqueue(hint),
    now,
    logger: dependencies.logger
  });
  const instance = await startLocalInstance(config, {
    configPath,
    requestListener,
    now: currentDate(now),
    pid: signalProcess?.pid ?? process.pid,
    isProcessLive: dependencies.isProcessLive
  });

  let uninstallSignals = () => {};
  let stopping = false;
  let resolveStopped;
  let rejectStopped;
  const stopped = new Promise((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });

  try {
    status = createStatusStore({
      config,
      instance: {
        ...instance.identity,
        endpoint: instance.endpoint
      },
      pid: signalProcess?.pid ?? process.pid,
      startedAt: currentDate(now)
    });

    const fizzy = await callFactory(dependencies.fizzyFactory, { config, status }) ?? createDefaultFizzy(config);
    const rawRunner = await callFactory(dependencies.runnerFactory, { config, status }) ?? createFakeCodexRunner();
    const runner = createCancellableRunner(rawRunner);
    const validation = await validateStartup({ config, fizzy, runner });
    status.recordStartupValidation(validation);
    status.updateRunnerHealth(validation.runnerHealth ?? { status: "unknown", kind: config.runner?.preferred ?? "unknown" });
    status.setRoutes(validation.routes ?? []);

    if (!validation.ok) {
      await writeSnapshot(status, config);
      await instance.cleanup();
      const error = new FizzySymphonyError("STARTUP_VALIDATION_FAILED", "Startup validation failed.", {
        errors: validation.errors,
        warnings: validation.warnings
      });
      throw error;
    }

    const claims = await callFactory(dependencies.claimsFactory, { config, fizzy, status }) ??
      createDefaultClaims({ config, fizzy, status });
    const workspaceManager = await callFactory(dependencies.workspaceManagerFactory, { config, status }) ??
      createDefaultWorkspaceManager();
    const workflowLoader = await callFactory(dependencies.workflowLoaderFactory, { config, status }) ??
      createDefaultWorkflowLoader();
    const router = await callFactory(dependencies.routerFactory, { config, status }) ??
      createDefaultRouter({ config, routes: () => status.status().routes });
    const orchestratorState = await callFactory(dependencies.orchestratorStateFactory, { config, claims, runner }) ??
      createOrchestratorState({ config, claims, runner });

    const recoveryRunner = dependencies.recoveryFactory
      ? await dependencies.recoveryFactory({ config, status, fizzy, orchestratorState })
      : performStartupRecovery;
    const recovery = await recoveryRunner({
      config,
      status,
      inspectInstances: async () => instance.registryReport
    });
    status.recordStartupRecovery(recovery);
    if ((recovery.errors ?? []).length > 0) {
      await writeSnapshot(status, config);
      await instance.cleanup();
      const error = new FizzySymphonyError("STARTUP_RECOVERY_FAILED", "Startup recovery failed.", {
        errors: recovery.errors,
        warnings: recovery.warnings
      });
      throw error;
    }

    scheduler = createReconciliationScheduler({
      intervalMs: config.polling?.interval_ms,
      immediate: schedulerOptions.immediate,
      timers: schedulerOptions.timers,
      hints: webhookHints,
      runTick: ({ webhookEvents }) => runReconciliationTick({
        config,
        status,
        fizzy,
        router,
        claims,
        workspaceManager,
        workflowLoader,
        runner,
        orchestratorState,
        routes: status.status().routes,
        webhookEvents,
        now
      }),
      snapshot: () => writeSnapshot(status, config)
    });

    async function stop(reason = "shutdown") {
      if (stopping) return stopped;
      stopping = true;
      uninstallSignals();
      await scheduler.stop({ wait: false });
      await instance.listener.close();
      await cancelActiveRuns({
        config,
        status,
        claims,
        workspaceManager,
        runner,
        orchestratorState,
        reason: "shutdown",
        now
      });
      status.recordShutdown({ reason, stopped_at: currentIso(now) });
      await writeSnapshot(status, config);
      await instance.cleanup();
      resolveStopped({ reason });
      return stopped;
    }

    const daemon = {
      config,
      status,
      endpoint: instance.endpoint,
      instance,
      scheduler,
      fizzy,
      runner,
      orchestratorState,
      stop,
      stopped
    };

    uninstallSignals = installSignalHandlers(signalProcess, (signal) => {
      void stop(`signal:${signal}`).catch((error) => {
        rejectStopped(error);
      });
    });

    scheduler.start({ immediate: schedulerOptions.immediate });
    await writeSnapshot(status, config);
    return daemon;
  } catch (error) {
    if (!stopping) {
      try {
        await scheduler?.stop?.({ wait: false });
        await instance.cleanup();
      } catch {
        // Startup failure should preserve the original error.
      }
    }
    throw error;
  }
}

function createDefaultClaims({ config, fizzy, status }) {
  if (config.diagnostics?.no_dispatch) {
    return {
      async acquire() {
        return { acquired: false, reason: "dispatch_disabled" };
      },
      async release() {
        return { released: true };
      }
    };
  }
  return createBoardClaimStore({ fizzy, status });
}

function createDefaultWorkspaceManager() {
  return {
    async resolveIdentity({ config, card, route }) {
      return resolveWorkspaceIdentity({ config, card, route });
    },
    async prepare({ config, identity, card, route, claim, decision }) {
      return prepareWorkspace({
        config,
        identity,
        metadata: {
          card_id: card?.id,
          route_id: route?.id,
          claim_id: claim?.claim_id ?? claim?.id,
          decision_reason: decision?.reason
        }
      });
    },
    async preserve({ run }) {
      return {
        status: "preserved",
        workspace_path: run.workspace_path ?? run.workspace?.path
      };
    }
  };
}

function createDefaultWorkflowLoader() {
  return {
    async load({ config, workspace }) {
      return loadWorkflow({ config, workspace });
    }
  };
}

function createDefaultRouter({ config, routes }) {
  return {
    async validateCandidate({ card }) {
      return routeCard({
        board: { id: card.board_id ?? card.board?.id },
        card,
        routes: routes(),
        config
      });
    }
  };
}

async function cancelActiveRuns(options = {}) {
  const {
    config,
    status,
    claims,
    workspaceManager,
    runner,
    orchestratorState,
    reason,
    now
  } = options;
  const snapshot = status.status();
  const activeRuns = snapshot.runs?.running ?? [];

  for (const run of activeRuns) {
    const cancellation = {
      final_status: "cancelled",
      reason,
      requested_at: currentIso(now),
      states: {
        cancel_requested: { status: "done", at: currentIso(now) },
        runner_cancel_sent: { status: "skipped" },
        claim_cancelled: { status: "pending" },
        workspace_preserved: { status: "pending" }
      },
      workspace_preserved: false
    };

    if (run.turn) {
      try {
        const cancelResult = await runner.cancel?.(run.turn, reason);
        cancellation.runner_cancel = cancelResult;
        cancellation.states.runner_cancel_sent = { status: "succeeded", at: currentIso(now), result: cancelResult };
      } catch (error) {
        cancellation.states.runner_cancel_sent = { status: "failed", at: currentIso(now), error: normalizeError(error) };
      }
    }

    try {
      const release = await claims?.release?.({ config, claim: run.claim ?? { ...run, status: "claimed" }, run, status: "cancelled", now: currentDate(now), reason });
      cancellation.claim_release = release;
      cancellation.states.claim_cancelled = { status: release?.released === false ? "failed" : "succeeded", at: currentIso(now), result: release };
    } catch (error) {
      cancellation.states.claim_cancelled = { status: "failed", at: currentIso(now), error: normalizeError(error) };
    }

    try {
      const preservation = await workspaceManager?.preserve?.({ config, run, reason, finalStatus: "cancelled" });
      cancellation.workspace_preserved = true;
      cancellation.workspace_preservation = preservation;
      cancellation.states.workspace_preserved = { status: "preserved", at: currentIso(now), result: preservation };
    } catch (error) {
      cancellation.states.workspace_preserved = { status: "failed", at: currentIso(now), error: normalizeError(error) };
    }

    const cancelled = status.cancelRun(run.id, cancellation, { final_status: "cancelled", cancellation });
    await status.writeRunAttemptRecord?.(cancelled ?? { ...run, cancellation, status: "cancelled" });
  }

  for (const run of orchestratorState?.snapshot?.().active_runs ?? []) {
    try {
      await orchestratorState.cancelRun?.(run, reason, { retry: false });
    } catch (error) {
      status.recordError?.({
        code: "ORCHESTRATOR_CANCEL_FAILED",
        message: "Orchestrator active run cancellation failed during shutdown.",
        details: { run_id: run.run_id ?? run.id, error: normalizeError(error) }
      });
    }
  }
  recordLifecycle(status, orchestratorState);
}

function createCancellableRunner(runner) {
  const cancellations = new Map();
  const cancelled = new Set();

  function entryFor(turn = {}) {
    const key = turn.turn_id ?? turn.id;
    if (!key) return null;
    if (!cancellations.has(key)) {
      let resolve;
      const promise = new Promise((resolved) => {
        resolve = resolved;
      });
      cancellations.set(key, { promise, resolve });
    }
    return cancellations.get(key);
  }

  return {
    ...runner,
    async stream(turn, onEvent) {
      const key = turn?.turn_id ?? turn?.id;
      const entry = entryFor(turn);
      const stream = runner.stream?.(turn, onEvent) ?? Promise.resolve({ status: "completed" });
      const cancellation = entry?.promise.then((reason) => ({
        status: "failed",
        failure_kind: "cancelled",
        error: {
          code: "RUN_CANCELLED",
          message: `Run cancelled: ${reason}`
        }
      }));
      const result = cancellation ? await Promise.race([stream, cancellation]) : await stream;
      if (key && cancelled.has(key) && result?.status === "completed") {
        return {
          status: "failed",
          failure_kind: "cancelled",
          error: {
            code: "RUN_CANCELLED",
            message: "Run cancelled before completion was accepted."
          }
        };
      }
      return result;
    },
    async cancel(turn, reason = "cancelled") {
      const key = turn?.turn_id ?? turn?.id;
      if (key) {
        cancelled.add(key);
        entryFor(turn)?.resolve(reason);
      }
      if (runner.cancel) return runner.cancel(turn, reason);
      return { status: "cancelled", success: true, reason };
    }
  };
}

function installSignalHandlers(signalProcess, onSignal) {
  if (!signalProcess?.on) return () => {};
  const handler = (signal) => onSignal(signal);
  signalProcess.on("SIGINT", handler);
  signalProcess.on("SIGTERM", handler);
  return () => {
    signalProcess.off?.("SIGINT", handler);
    signalProcess.off?.("SIGTERM", handler);
  };
}

async function callFactory(factory, args) {
  if (typeof factory !== "function") return null;
  return factory(args);
}

async function writeSnapshot(status, config) {
  const snapshotPath = config.observability?.status_snapshot_path;
  if (!snapshotPath) return null;
  return status.writeSnapshot(snapshotPath);
}

function createDefaultFizzy(config) {
  return config.diagnostics?.no_dispatch ? createNoopFizzy() : createUnavailableFizzy();
}

function createNoopFizzy() {
  return {
    async getIdentity() {
      return { user: { id: "unknown" } };
    },
    async listUsers() {
      return [];
    },
    async listTags() {
      return [];
    },
    async getEntropy() {
      return { warnings: [] };
    },
    async getBoard(boardId) {
      return { id: boardId, columns: [], cards: [] };
    },
    async discoverCandidates() {
      return [];
    },
    etagStats() {
      return { hits: 0, misses: 0, invalid: 0 };
    }
  };
}

function createUnavailableFizzy() {
  async function unavailable() {
    throw new FizzySymphonyError(
      "FIZZY_CLIENT_UNAVAILABLE",
      "No Fizzy client factory was provided for daemon startup.",
      { inject: "dependencies.fizzyFactory" }
    );
  }

  return {
    getIdentity: unavailable,
    listUsers: unavailable,
    listTags: unavailable,
    getEntropy: unavailable,
    getBoard: unavailable,
    discoverCandidates: unavailable
  };
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

function currentDate(now) {
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date ? value : new Date(value);
}

function currentIso(now) {
  return currentDate(now).toISOString();
}

function normalizeError(error = {}) {
  return {
    code: error.code ?? "ERROR",
    message: error.message ?? String(error),
    details: error.details ?? {}
  };
}
