import { createWebhookHintQueue } from "./server.js";

const DEFAULT_INTERVAL_MS = 30000;

export function createReconciliationScheduler(options = {}) {
  const {
    intervalMs = DEFAULT_INTERVAL_MS,
    runTick,
    snapshot = async () => null,
    timers = globalThis,
    hints = createWebhookHintQueue()
  } = options;

  let stopped = false;
  let started = false;
  let running = false;
  let pendingReason = null;
  let timer = null;
  let activePromise = null;

  function start(startOptions = {}) {
    if (started) return;
    started = true;
    stopped = false;
    if (startOptions.immediate !== false && options.immediate !== false) {
      schedule("startup", 0);
    } else {
      schedule("interval", intervalMs);
    }
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

  function enqueueWebhookHint(hint) {
    hints.enqueue(hint);
    void tickNow("webhook");
  }

  function tickNow(reason = "manual") {
    if (stopped) return Promise.resolve({ ignored: true, reason: "stopped" });
    if (running) {
      pendingReason = pendingReason === "webhook" ? "webhook" : reason;
      return activePromise?.then(() => activePromise ?? Promise.resolve({ queued: true })) ?? Promise.resolve({ queued: true });
    }

    activePromise = runOnce(reason);
    return activePromise;
  }

  async function runOnce(reason) {
    running = true;
    if (timer) {
      timers.clearTimeout?.(timer);
      timer = null;
    }

    try {
      const webhookEvents = hints.drain();
      const result = await runTick?.({ reason, webhookEvents });
      await snapshot?.({ reason, result });
      return result;
    } finally {
      running = false;
      activePromise = null;
      if (pendingReason && !stopped) {
        const nextReason = hints.size > 0 ? "webhook" : pendingReason;
        pendingReason = null;
        activePromise = runOnce(nextReason);
      } else if (!stopped && started) {
        schedule("interval", intervalMs);
      }
    }
  }

  function schedule(reason, delay) {
    if (stopped || timer) return;
    timer = timers.setTimeout?.(async () => {
      timer = null;
      try {
        await tickNow(reason);
      } catch {
        if (!stopped && started) schedule("interval", intervalMs);
      }
    }, delay);
    timer?.unref?.();
  }

  return {
    start,
    stop,
    tickNow,
    enqueueWebhookHint,
    hints,
    get running() {
      return running;
    },
    get stopped() {
      return stopped;
    }
  };
}
