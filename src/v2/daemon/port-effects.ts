// Port effects: translate accepted operator commands into live CodexRunnerPort
// calls. This is the layer the deferred adapters sit beneath — given the status
// snapshot taken *before* the model reducer ran (so the affected run is still in
// `running`), it dispatches cancel/stop to the runner and returns audit events
// describing what the runner did. It never mutates status; the reducer owns that.

import type {
  CodexRunnerPort,
  OperatorCommand,
  RuntimeEvent,
  SymphonyStatus
} from "../core/types.ts";

export type PortEffectDraft = Omit<RuntimeEvent, "id" | "at">;

export interface PortEffectContext {
  codex?: CodexRunnerPort;
}

// Dispatch the runner-facing side effects for a command. `preStatus` MUST be the
// status snapshot from before the reducer ran. Returns the audit events to
// append (empty when there is nothing to do or no runner is wired).
export async function dispatchPortEffects(
  command: OperatorCommand,
  preStatus: SymphonyStatus,
  ctx: PortEffectContext
): Promise<PortEffectDraft[]> {
  const codex = ctx.codex;
  if (!codex) return [];

  switch (command.type) {
    case "run.cancel": {
      const run = preStatus.runs.running.find((entry) => entry.id === command.runId);
      if (!run) return [];
      if (!run.turnId) {
        return [
          {
            type: "command.effect.run.cancel",
            severity: "warning",
            message: `Run ${command.runId} has no active turn; nothing to cancel on the runner.`,
            runId: command.runId,
            sessionId: run.sessionId
          }
        ];
      }
      try {
        const result = await codex.cancelTurn({
          turn: { turnId: run.turnId, sessionId: run.sessionId ?? "" },
          reason: command.reason
        });
        return [
          {
            type: "command.effect.run.cancel",
            severity: "info",
            message: `Runner cancelled turn ${run.turnId} (${result.status}).`,
            runId: command.runId,
            sessionId: run.sessionId,
            data: result
          }
        ];
      } catch (error) {
        return [
          {
            type: "command.effect.run.cancel",
            severity: "error",
            message: `Runner cancel failed for run ${command.runId}: ${(error as Error).message}`,
            runId: command.runId,
            sessionId: run.sessionId,
            data: { code: "RUNNER_CANCEL_FAILED" }
          }
        ];
      }
    }
    case "session.stop": {
      const runs = preStatus.runs.running.filter((entry) => entry.sessionId === command.sessionId);
      if (runs.length === 0) return [];
      const workspacePath = runs.find((entry) => entry.workspacePath)?.workspacePath ?? "";
      try {
        await codex.stopSession({
          session: { sessionId: command.sessionId, workspacePath },
          reason: command.reason
        });
        if (codex.terminateOwnedProcess) {
          await codex.terminateOwnedProcess({ sessionId: command.sessionId, reason: command.reason });
        }
        return [
          {
            type: "command.effect.session.stop",
            severity: "info",
            message: `Runner stopped session ${command.sessionId} (${runs.length} run${runs.length === 1 ? "" : "s"}).`,
            sessionId: command.sessionId
          }
        ];
      } catch (error) {
        return [
          {
            type: "command.effect.session.stop",
            severity: "error",
            message: `Runner stop failed for session ${command.sessionId}: ${(error as Error).message}`,
            sessionId: command.sessionId,
            data: { code: "RUNNER_STOP_FAILED" }
          }
        ];
      }
    }
    default:
      return [];
  }
}
