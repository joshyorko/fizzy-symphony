const CONTRACT = "codex-runner-fake-v1";

export { createCodexCliAppServerRunner } from "./codex-cli-app-server-runner.js";

export function createFakeCodexRunner(options = {}) {
  let sessionCounter = 0;
  let turnCounter = 0;

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

    async validate(config = {}, workspace = null) {
      return {
        ok: true,
        kind: config.preferred ?? options.kind ?? "cli_app_server",
        contract: options.contract ?? CONTRACT,
        workspace
      };
    },

    async health() {
      return {
        status: options.healthStatus ?? "ready",
        kind: options.kind ?? "cli_app_server",
        contract: options.contract ?? CONTRACT
      };
    },

    async startSession(workspace, policies = {}, metadata = {}) {
      sessionCounter += 1;
      return {
        session_id: `session_${sessionCounter}`,
        workspace,
        policies,
        metadata,
        process_owned: options.processOwned
      };
    },

    async startTurn(session, prompt, metadata = {}) {
      turnCounter += 1;
      return {
        turn_id: `turn_${turnCounter}`,
        session_id: session.session_id,
        session,
        prompt,
        metadata
      };
    },

    async stream(turn, onEvent) {
      if (options.mode === "input_required") {
        return turnFailure(turn, "input_required", "RUNNER_INPUT_REQUIRED", "Runner requested operator input in unattended mode.");
      }

      if (options.mode === "error") {
        return turnFailure(turn, "runner_error", options.errorCode ?? "RUNNER_ERROR", "Fake runner error.");
      }

      const events = options.events ?? [
        { type: "turn.started" },
        { type: "assistant.delta", text: "ok" },
        { type: "turn.completed" }
      ];

      for (const event of events) {
        onEvent?.({ ...event, session_id: turn.session_id, turn_id: turn.turn_id });
      }

      return {
        type: "TurnResult",
        status: "completed",
        session_id: turn.session_id,
        turn_id: turn.turn_id,
        events
      };
    },

    async cancel(turn, reason = "cancelled") {
      const status = options.cancelStatus ?? "cancelled";
      return {
        type: "CancelResult",
        status,
        success: status === "cancelled",
        session_id: turn.session_id,
        turn_id: turn.turn_id,
        reason
      };
    },

    async stopSession(session) {
      const status = options.stopSessionStatus ?? "stopped";
      return {
        type: "StopSessionResult",
        status,
        success: status === "stopped",
        session_id: session.session_id
      };
    },

    async terminateOwnedProcess(session) {
      const status = options.terminateOwnedProcessStatus ?? "terminated";
      return {
        type: "TerminateProcessResult",
        status,
        success: status === "terminated",
        session_id: session.session_id
      };
    }
  };
}

function turnFailure(turn, failureKind, code, message) {
  return {
    type: "TurnResult",
    status: "failed",
    session_id: turn.session_id,
    turn_id: turn.turn_id,
    failure_kind: failureKind,
    error: {
      type: "RunnerError",
      code,
      message
    }
  };
}
