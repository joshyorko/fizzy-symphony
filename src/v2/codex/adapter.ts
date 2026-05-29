// Codex runner adapter boundary.
//
// Codex SDK compatibility matters, so the runner sits behind CodexRunnerPort
// (core/types.ts). Adapter priority for production v2:
//
//   1. Codex SDK adapter           — preferred where practical.
//   2. Codex CLI app-server runner — v1 already ships this in
//      src/codex-cli-app-server-runner.js for streaming/cancel/session control.
//   3. Fake runner                 — ./fake.ts, used by tests.
//
// For the spike we expose a typed factory that advertises its mode via
// describe() and throws a clear "not wired" error if a live op is invoked.
// The cockpit never talks to Codex directly; only the daemon runtime does.

import type { CodexRunnerPort } from "../core/types.ts";

export type CodexAdapterMode = "sdk" | "cli-app-server";

export interface CodexAdapterOptions {
  mode?: CodexAdapterMode;
  command?: string;
  protocolVersion?: string;
}

const SDK_CONTRACT = "codex-runner-sdk-v1";
const CLI_CONTRACT = "codex-runner-cli-app-server-v1";

function notWired(operation: string, mode: CodexAdapterMode): never {
  const error = new Error(
    `CodexRunnerPort.${operation} is not wired in the v2 spike (${mode} mode). ` +
      `Delegate to v1 src/codex-cli-app-server-runner.js or the Codex SDK here.`
  );
  (error as { code?: string }).code = "CODEX_ADAPTER_NOT_WIRED";
  throw error;
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): CodexRunnerPort {
  const mode: CodexAdapterMode = options.mode ?? "sdk";
  const contract = mode === "sdk" ? SDK_CONTRACT : CLI_CONTRACT;
  const note =
    mode === "sdk"
      ? "v2 spike: Codex SDK adapter (preferred), not wired"
      : "v2 spike: delegate to v1 codex-cli-app-server-runner";

  return {
    describe() {
      return { kind: `codex-${mode}`, sdk: mode === "sdk", contract, note };
    },
    async detect() {
      return { kind: `codex-${mode}`, available: false, contract, sdk: mode === "sdk", note };
    },
    async health() {
      return {
        status: "unknown",
        kind: `codex-${mode}`,
        contract,
        failureCode: "ADAPTER_NOT_WIRED",
        remediation: note
      };
    },
    startSession: async () => notWired("startSession", mode),
    startTurn: async () => notWired("startTurn", mode),
    streamTurn: async () => notWired("streamTurn", mode),
    cancelTurn: async () => notWired("cancelTurn", mode),
    stopSession: async () => notWired("stopSession", mode)
  };
}
