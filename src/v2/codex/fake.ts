// Fake CodexRunnerPort for tests.
//
// Deterministic, in-memory, no subprocess. Keeps unit tests independent of a
// live Codex CLI or SDK. Mirrors the streaming/cancel/session-stop surface so
// the daemon runtime can be exercised end to end against fixtures.

import type {
  CancelTurnInput,
  CodexRunnerPort,
  RunnerDetectInput,
  RunnerDetectResult,
  RunnerEventSink,
  RunnerHealthInput,
  RunnerHealthResult,
  SessionHandle,
  StartSessionInput,
  StartTurnInput,
  StopSessionInput,
  StreamTurnInput,
  TerminateProcessInput,
  TurnHandle,
  TurnResult
} from "../core/types.ts";

export interface CodexFakeOptions {
  available?: boolean;
  healthStatus?: "ready" | "unavailable" | "unknown";
  mode?: "completed" | "failed" | "input_required";
  events?: Array<{ type: string; text?: string }>;
  contract?: string;
}

const CONTRACT = "codex-runner-fake-v2";

export function createFakeCodexRunner(options: CodexFakeOptions = {}): CodexRunnerPort {
  let sessionCounter = 0;
  let turnCounter = 0;
  const available = options.available ?? true;
  const contract = options.contract ?? CONTRACT;

  return {
    describe() {
      return { kind: "fake", sdk: false, contract, note: "fixture-backed CodexRunnerPort" };
    },
    async detect(_input?: RunnerDetectInput): Promise<RunnerDetectResult> {
      return { kind: "fake", available, contract, sdk: false, note: "fake runner" };
    },
    async health(_input?: RunnerHealthInput): Promise<RunnerHealthResult> {
      return {
        status: options.healthStatus ?? (available ? "ready" : "unavailable"),
        kind: "fake",
        contract,
        checkedAt: new Date(0).toISOString()
      };
    },
    async startSession(input: StartSessionInput): Promise<SessionHandle> {
      sessionCounter += 1;
      return { sessionId: `session_${sessionCounter}`, workspacePath: input.workspacePath };
    },
    async startTurn(input: StartTurnInput): Promise<TurnHandle> {
      turnCounter += 1;
      return { turnId: `turn_${turnCounter}`, sessionId: input.session.sessionId };
    },
    async streamTurn(input: StreamTurnInput, onEvent: RunnerEventSink): Promise<TurnResult> {
      const events = options.events ?? [
        { type: "turn.started" },
        { type: "assistant.delta", text: "ok" },
        { type: "turn.completed" }
      ];
      for (const event of events) {
        onEvent({ type: event.type, text: event.text });
      }
      if (options.mode === "failed") {
        return {
          status: "failed",
          turnId: input.turn.turnId,
          sessionId: input.turn.sessionId,
          error: { code: "RUNNER_ERROR", message: "fake runner error" }
        };
      }
      if (options.mode === "input_required") {
        return {
          status: "input_required",
          turnId: input.turn.turnId,
          sessionId: input.turn.sessionId,
          error: { code: "RUNNER_INPUT_REQUIRED", message: "runner requested input in unattended mode" }
        };
      }
      return { status: "completed", turnId: input.turn.turnId, sessionId: input.turn.sessionId };
    },
    async cancelTurn(input: CancelTurnInput): Promise<TurnResult> {
      return { status: "cancelled", turnId: input.turn.turnId, sessionId: input.turn.sessionId };
    },
    async stopSession(_input: StopSessionInput): Promise<void> {
      // no-op for the fake
    },
    async terminateOwnedProcess(_input: TerminateProcessInput): Promise<void> {
      // no-op for the fake
    }
  };
}
