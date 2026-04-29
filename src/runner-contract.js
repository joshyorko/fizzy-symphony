const CONTRACT = "codex-runner-fake-v1";

export function createFakeCodexRunner(options = {}) {
  let sessionCounter = 0;

  return {
    async detect() {
      const report = {
        kind: options.kind ?? "cli_app_server",
        available: options.available ?? true,
        contract: options.contract ?? CONTRACT
      };
      if (options.package) report.package = options.package;
      return report;
    },

    async validate(config = {}) {
      return {
        ok: true,
        kind: config.preferred ?? options.kind ?? "cli_app_server",
        contract: options.contract ?? CONTRACT
      };
    },

    async health() {
      return {
        status: options.healthStatus ?? "ready",
        kind: options.kind ?? "cli_app_server",
        contract: options.contract ?? CONTRACT
      };
    },

    async startSession(request = {}) {
      sessionCounter += 1;
      return {
        session_id: `session_${sessionCounter}`,
        workspace: request.workspace,
        metadata: request.metadata ?? {}
      };
    },

    async initSession(session) {
      return { ok: true, session_id: session.session_id };
    },

    async runTurn(session, request = {}) {
      if (options.mode === "input_required") {
        return turnFailure("input_required", "RUNNER_INPUT_REQUIRED", "Runner requested operator input in unattended mode.");
      }

      if (options.mode === "error") {
        return turnFailure("runner_error", options.errorCode ?? "RUNNER_ERROR", "Fake runner error.");
      }

      const events = options.events ?? [
        { type: "turn.started" },
        { type: "assistant.delta", text: "ok" },
        { type: "turn.completed" }
      ];

      for (const event of events) {
        request.onEvent?.({ ...event, session_id: session.session_id });
      }

      return {
        type: "TurnResult",
        status: "completed",
        session_id: session.session_id,
        events
      };
    },

    async cancel(session, request = {}) {
      return {
        type: "TurnResult",
        status: "cancelled",
        session_id: session.session_id,
        cancellation: { reason: request.reason ?? "cancelled" }
      };
    }
  };
}

function turnFailure(failureKind, code, message) {
  return {
    type: "TurnResult",
    status: "failed",
    failure_kind: failureKind,
    error: {
      type: "RunnerError",
      code,
      message
    }
  };
}
