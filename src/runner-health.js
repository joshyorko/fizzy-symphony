const DEFAULT_RUNNER_HEALTH_INTERVAL_MS = 60000;

export function createRunnerHealthMonitor(options = {}) {
  const {
    config = {},
    runner,
    status,
    snapshot = async () => null,
    timers = globalThis,
    now = () => new Date()
  } = options;

  const healthConfig = config.runner?.health ?? {};
  const enabled = healthConfig.enabled !== false;
  const intervalMs = Number(healthConfig.interval_ms ?? DEFAULT_RUNNER_HEALTH_INTERVAL_MS);
  let started = false;
  let stopped = true;
  let timer = null;
  let activePromise = null;

  function start() {
    if (!enabled || started) return;
    started = true;
    stopped = false;
    schedule();
  }

  function stop(stopOptions = {}) {
    stopped = true;
    if (timer) {
      timers.clearTimeout?.(timer);
      timer = null;
    }
    if (stopOptions.wait === false) return Promise.resolve();
    return activePromise ?? Promise.resolve();
  }

  function checkNow(reason = "manual") {
    if (!enabled || stopped) return Promise.resolve({ ignored: true, reason: "stopped" });
    if (activePromise) return activePromise;
    activePromise = runCheck(reason).finally(() => {
      activePromise = null;
      schedule();
    });
    return activePromise;
  }

  function schedule() {
    if (!enabled || stopped || timer || !Number.isFinite(intervalMs) || intervalMs <= 0) return;
    timer = timers.setTimeout?.(async () => {
      timer = null;
      await checkNow("interval");
    }, intervalMs);
    timer?.unref?.();
  }

  async function runCheck(reason) {
    const checkedAt = currentIso(now);
    let report;
    try {
      report = runner?.health
        ? await runner.health(config.runner)
        : {
            status: "unavailable",
            kind: config.runner?.preferred ?? "unknown",
            reason: "Runner does not expose a health check."
          };
      report = {
        ...report,
        checked_at: report?.checked_at ?? checkedAt
      };
    } catch (error) {
      report = {
        status: "unavailable",
        kind: config.runner?.preferred ?? "unknown",
        checked_at: checkedAt,
        error: normalizeError(error)
      };
      status?.recordRuntimeWarning?.({
        code: "RUNNER_HEALTH_CHECK_FAILED",
        message: "Periodic runner health check failed.",
        error: report.error,
        recorded_at: checkedAt
      });
    }

    status?.updateRunnerHealth?.(report);
    try {
      await snapshot?.({ reason: `runner-health:${reason}`, runner_health: report });
    } catch (error) {
      status?.recordRuntimeWarning?.({
        code: "RUNNER_HEALTH_SNAPSHOT_FAILED",
        message: "Periodic runner health snapshot write failed.",
        error: normalizeError(error),
        recorded_at: currentIso(now)
      });
    }
    return report;
  }

  return {
    start,
    stop,
    checkNow,
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    }
  };
}

function currentIso(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function normalizeError(error = {}) {
  return {
    code: error.code ?? "ERROR",
    message: error.message ?? String(error),
    details: error.details ?? {}
  };
}
