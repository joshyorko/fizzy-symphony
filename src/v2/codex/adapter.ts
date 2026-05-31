// Codex runner adapter boundary.
//
// Codex SDK/app-server compatibility matters, so both live implementations sit
// behind CodexRunnerPort (core/types.ts). The adapters translate native Codex
// SDK objects or the existing v1 CLI app-server runner into the same v2 port
// vocabulary. The cockpit never talks to Codex directly.

import { createCodexCliAppServerRunner } from "../../codex-cli-app-server-runner.js";
import type { CodexRunnerPort } from "../core/types.ts";

export type CodexAdapterMode = "sdk" | "cli-app-server";

export interface CodexAdapterOptions {
  mode?: CodexAdapterMode;
  runner?: Record<string, any>;
  runnerFactory?: (options?: Record<string, unknown>) => Record<string, any>;
  sdkFactory?: (options?: Record<string, unknown>) => Record<string, any>;
  sdkModuleLoader?: () => Promise<Record<string, any>>;
  config?: Record<string, any>;
  command?: string;
  apiKey?: string;
  baseUrl?: string;
  codexPathOverride?: string;
  env?: Record<string, string>;
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
  let cachedRunner: Record<string, any> | null = null;
  const sessions = new Map<string, Record<string, any>>();
  const stoppedSessions = new Set<string>();
  const turns = new Map<string, Record<string, any>>();
  const note =
    mode === "sdk"
      ? "delegates to @openai/codex-sdk"
      : "delegates to v1 codex-cli-app-server-runner";

  function runner() {
    if (options.runner) return options.runner;
    if (cachedRunner) return cachedRunner;
    const factory = options.runnerFactory ??
      (mode === "sdk" ? createCodexSdkRunner : createCodexCliAppServerRunner);
    cachedRunner = factory(options);
    return cachedRunner;
  }

  function config() {
    return {
      ...(options.config ?? {}),
      runner: {
        ...(options.config?.runner ?? {}),
        preferred: options.config?.runner?.preferred ?? (mode === "cli-app-server" ? "cli_app_server" : "sdk"),
        cli_app_server: {
          ...(options.config?.runner?.cli_app_server ?? {}),
          command: options.command ?? options.config?.runner?.cli_app_server?.command
        }
      }
    };
  }

  return {
    describe() {
      return { kind: `codex-${mode}`, sdk: mode === "sdk", contract, note };
    },
    async detect() {
      const delegate = runner();
      if (!delegate?.detect) return { kind: `codex-${mode}`, available: false, contract, sdk: mode === "sdk", note };
      const report = await delegate.detect(config());
      return {
        kind: report.kind ?? `codex-${mode}`,
        available: report.available !== false,
        contract: report.contract ?? contract,
        version: report.version,
        sdk: mode === "sdk",
        note: report.reason ?? report.message ?? note
      };
    },
    async health() {
      const delegate = runner();
      if (!delegate?.health) {
        return {
          status: "unknown",
          kind: `codex-${mode}`,
          contract,
          failureCode: "ADAPTER_NOT_WIRED",
          remediation: note
        };
      }
      const report = await delegate.health(config());
      return {
        status: normalizeHealthStatus(report.status),
        kind: report.kind ?? `codex-${mode}`,
        contract: report.contract ?? contract,
        checkedAt: report.checked_at ?? report.checkedAt,
        failureCode: report.failure_code ?? report.failureCode,
        remediation: report.remediation
      };
    },
    async startSession(input) {
      const delegate = runner();
      if (!delegate?.startSession) return notWired("startSession", mode);
      const session = await delegate.startSession(
        input.workspacePath,
        {
          config: config(),
          route: { model: input.model },
          runner: config().runner
        },
        input.metadata ?? {}
      );
      const sessionId = session.session_id ?? session.sessionId ?? session.id;
      sessions.set(String(sessionId), session);
      stoppedSessions.delete(String(sessionId));
      return {
        sessionId: String(sessionId),
        workspacePath: session.workspace_path ?? session.workspace ?? input.workspacePath
      };
    },
    async startTurn(input) {
      const delegate = runner();
      if (!delegate?.startTurn) return notWired("startTurn", mode);
      const session = sessions.get(input.session.sessionId) ?? {
        session_id: input.session.sessionId,
        thread_id: input.session.sessionId,
        workspace_path: input.session.workspacePath
      };
      const turn = await delegate.startTurn(session, input.prompt, input.metadata ?? {});
      const turnId = turn.turn_id ?? turn.turnId ?? turn.id;
      turns.set(turnKey(input.session.sessionId, turnId), turn);
      return { turnId: String(turnId), sessionId: input.session.sessionId };
    },
    async streamTurn(input, onEvent) {
      const delegate = runner();
      if (!delegate?.stream) return notWired("streamTurn", mode);
      const turn = storedTurn(input.turn) ?? {
        turn_id: input.turn.turnId,
        session_id: input.turn.sessionId,
        thread_id: input.turn.sessionId
      };
      const result = await delegate.stream(turn, (event: Record<string, any>) => onEvent(normalizeRunnerEvent(event)));
      return normalizeTurnResult(result, input.turn);
    },
    async cancelTurn(input) {
      const delegate = runner();
      if (!delegate?.cancel) return notWired("cancelTurn", mode);
      const turn = storedTurn(input.turn) ?? {
        turn_id: input.turn.turnId,
        session_id: input.turn.sessionId,
        thread_id: input.turn.sessionId
      };
      return normalizeTurnResult(await delegate.cancel(turn, input.reason), input.turn);
    },
    async stopSession(input) {
      const delegate = runner();
      if (!delegate?.stopSession) return notWired("stopSession", mode);
      const session = sessions.get(input.session.sessionId) ?? {
        session_id: input.session.sessionId,
        thread_id: input.session.sessionId,
        workspace_path: input.session.workspacePath
      };
      const result = await delegate.stopSession(session);
      if (result?.success === false) {
        throw new Error(result.error?.message ?? `Codex stopSession failed: ${result.status ?? "unknown"}`);
      }
      sessions.delete(input.session.sessionId);
      stoppedSessions.add(input.session.sessionId);
    },
    async terminateOwnedProcess(input) {
      const delegate = runner();
      if (!delegate?.terminateOwnedProcess) return;
      if (stoppedSessions.has(input.sessionId) && !sessions.has(input.sessionId)) return;
      const session = sessions.get(input.sessionId) ?? {
        session_id: input.sessionId,
        thread_id: input.sessionId,
        process_owned: true
      };
      const result = await delegate.terminateOwnedProcess(session);
      if (result?.success === false && result.status !== "unknown_ownership") {
        throw new Error(result.error?.message ?? `Codex terminateOwnedProcess failed: ${result.status ?? "unknown"}`);
      }
      sessions.delete(input.sessionId);
      if (result?.success !== false) stoppedSessions.add(input.sessionId);
    }
  };

  function storedTurn(turn: { sessionId: string; turnId: string }) {
    return turns.get(turnKey(turn.sessionId, turn.turnId));
  }
}

function turnKey(sessionId: string, turnId: string | number) {
  return `${sessionId}:${turnId}`;
}

function normalizeHealthStatus(status: string): "ready" | "unavailable" | "unknown" {
  if (status === "ready") return "ready";
  if (status === "unavailable") return "unavailable";
  return "unknown";
}

function normalizeRunnerEvent(event: Record<string, any>) {
  return {
    type: String(event.type ?? event.event ?? "runner.event"),
    text: event.text,
    data: event.data ?? event
  };
}

function normalizeTurnResult(result: Record<string, any> = {}, fallback: { turnId: string; sessionId: string }) {
  const status = result.failure_kind === "input_required"
    ? "input_required"
    : normalizeTurnStatus(result.status);
  return {
    status,
    turnId: String(result.turn_id ?? result.turnId ?? fallback.turnId),
    sessionId: String(result.session_id ?? result.sessionId ?? fallback.sessionId),
    error: result.error
      ? {
          code: result.error.code ?? "RUNNER_ERROR",
          message: result.error.message ?? String(result.error),
          remediation: result.error.remediation
        }
      : undefined
  };
}

function normalizeTurnStatus(status: string): "completed" | "failed" | "cancelled" | "input_required" {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "input_required") return "input_required";
  return "failed";
}

function createCodexSdkRunner(options: CodexAdapterOptions = {}) {
  let sessionCounter = 0;
  let turnCounter = 0;
  const sessions = new Map<string, Record<string, any>>();
  const turns = new Map<string, Record<string, any>>();

  return {
    async detect(config = {}) {
      try {
        await loadCodexClass(options);
        return {
          kind: "sdk",
          available: true,
          contract: SDK_CONTRACT,
          package: "@openai/codex-sdk",
          version: config?.runner?.sdk?.version
        };
      } catch (error) {
        return {
          kind: "sdk",
          available: false,
          contract: SDK_CONTRACT,
          package: "@openai/codex-sdk",
          reason: (error as Error).message,
          remediation: "Install @openai/codex-sdk and ensure the Codex CLI binary it wraps is available."
        };
      }
    },

    async health(config = {}) {
      const report = await this.detect(config);
      if (report.available) {
        return {
          status: "ready",
          kind: "sdk",
          contract: SDK_CONTRACT,
          package: "@openai/codex-sdk",
          smoke_turn_skipped: true
        };
      }
      return {
        status: "unavailable",
        kind: "sdk",
        contract: SDK_CONTRACT,
        failure_code: "CODEX_SDK_UNAVAILABLE",
        failure_message: report.reason,
        remediation: report.remediation
      };
    },

    async startSession(workspace: string, policies: Record<string, any> = {}, metadata: Record<string, any> = {}) {
      sessionCounter += 1;
      const config = adapterConfig(policies, options);
      const codex = await createSdkClient(options, config);
      const threadOptions = sdkThreadOptions(workspace, policies, config);
      const threadId = metadata.threadId ?? metadata.thread_id;
      const thread = threadId
        ? codex.resumeThread(String(threadId), threadOptions)
        : codex.startThread(threadOptions);
      const sessionId = String(thread.id ?? threadId ?? `sdk_session_${sessionCounter}`);
      const session = {
        type: "Session",
        session_id: sessionId,
        thread_id: thread.id ?? threadId ?? sessionId,
        kind: "sdk",
        implementation: "CodexSdkRunner",
        process_owned: false,
        workspace,
        workspace_path: workspace,
        metadata,
        thread
      };
      sessions.set(sessionId, session);
      return session;
    },

    async startTurn(session: Record<string, any>, prompt: string, metadata: Record<string, any> = {}) {
      turnCounter += 1;
      const sessionId = session.session_id;
      const turnId = `sdk_turn_${turnCounter}`;
      const turn = {
        type: "Turn",
        session_id: sessionId,
        thread_id: session.thread_id,
        turn_id: turnId,
        prompt,
        metadata
      };
      turns.set(turnKey(sessionId, turnId), turn);
      return turn;
    },

    async stream(turn: Record<string, any>, onEvent?: (event: Record<string, any>) => void) {
      const session = sessions.get(turn.session_id);
      const stored = turns.get(turnKey(turn.session_id, turn.turn_id)) ?? turn;
      if (!session?.thread) {
        return sdkTurnFailure(turn, "CODEX_SDK_SESSION_NOT_FOUND", "Codex SDK session is not active.");
      }

      const controller = new AbortController();
      stored.abortController = controller;
      const emitted: Record<string, any>[] = [];
      let status = "completed";
      let error;

      try {
        const result = await session.thread.runStreamed(stored.prompt ?? "", { signal: controller.signal });
        for await (const event of result.events) {
          if (event.type === "thread.started" && event.thread_id) {
            session.thread_id = event.thread_id;
          }
          emitted.push(event);
          onEvent?.(event);
          if (event.type === "turn.failed" || event.type === "error") {
            status = "failed";
            error = sdkEventError(event);
          }
        }
      } catch (caught) {
        if (controller.signal.aborted) {
          status = "cancelled";
        } else {
          status = "failed";
          error = {
            type: "RunnerError",
            code: "CODEX_SDK_RUN_FAILED",
            message: (caught as Error).message
          };
        }
      } finally {
        delete stored.abortController;
      }

      return {
        type: "TurnResult",
        status,
        session_id: turn.session_id,
        thread_id: session.thread_id,
        turn_id: turn.turn_id,
        events: emitted,
        error
      };
    },

    async cancel(turn: Record<string, any>, reason = "cancelled") {
      const stored = turns.get(turnKey(turn.session_id, turn.turn_id));
      stored?.abortController?.abort?.();
      return {
        type: "CancelResult",
        status: "cancelled",
        success: true,
        session_id: turn.session_id,
        thread_id: turn.thread_id,
        turn_id: turn.turn_id,
        reason
      };
    },

    async stopSession(session: Record<string, any>) {
      for (const turn of turns.values()) {
        if (turn.session_id === session.session_id) turn.abortController?.abort?.();
      }
      sessions.delete(session.session_id);
      return {
        type: "StopSessionResult",
        status: "stopped",
        success: true,
        session_id: session.session_id,
        thread_id: session.thread_id
      };
    },

    async terminateOwnedProcess(session: Record<string, any>) {
      return {
        type: "TerminateProcessResult",
        status: "unknown_ownership",
        success: false,
        session_id: session.session_id,
        thread_id: session.thread_id,
        remediation: "The Codex SDK does not expose an owned app-server process for this session."
      };
    }
  };
}

async function createSdkClient(options: CodexAdapterOptions, config: Record<string, any>) {
  const sdkOptions = sdkClientOptions(options, config);
  if (options.sdkFactory) return options.sdkFactory(sdkOptions);
  const Codex = await loadCodexClass(options);
  return new Codex(sdkOptions);
}

async function loadCodexClass(options: CodexAdapterOptions) {
  if (options.sdkFactory) return options.sdkFactory;
  const mod = options.sdkModuleLoader ? await options.sdkModuleLoader() : await import("@openai/codex-sdk");
  const Codex = mod.Codex ?? mod.default?.Codex ?? mod.default;
  if (typeof Codex !== "function") {
    throw new Error("@openai/codex-sdk did not export a Codex class.");
  }
  return Codex;
}

function adapterConfig(policies: Record<string, any>, options: CodexAdapterOptions) {
  return policies.config ?? options.config ?? {};
}

function sdkClientOptions(options: CodexAdapterOptions, config: Record<string, any>) {
  return withoutUndefined({
    codexPathOverride: options.codexPathOverride ?? options.command ?? config.runner?.sdk?.codex_path,
    baseUrl: options.baseUrl ?? config.runner?.sdk?.base_url,
    apiKey: options.apiKey ?? config.runner?.sdk?.api_key,
    config: config.runner?.sdk?.config,
    env: options.env
  });
}

function sdkThreadOptions(workspace: string, policies: Record<string, any>, config: Record<string, any>) {
  const runnerCodex = config.runner?.codex ?? {};
  return withoutUndefined({
    model: policies.route?.model || config.agent?.default_model || undefined,
    workingDirectory: workspace,
    sandboxMode: sdkSandboxMode(runnerCodex.thread_sandbox ?? runnerCodex.turn_sandbox_policy?.type),
    skipGitRepoCheck: config.runner?.sdk?.skip_git_repo_check,
    modelReasoningEffort: config.agent?.reasoning_effort,
    networkAccessEnabled: runnerCodex.turn_sandbox_policy?.network_access,
    webSearchMode: runnerCodex.web_search_mode,
    approvalPolicy: sdkApprovalPolicy(runnerCodex.approval_policy?.mode ?? runnerCodex.approval_policy),
    additionalDirectories: runnerCodex.additional_directories
  });
}

function sdkSandboxMode(value: unknown) {
  if (value === "workspaceWrite") return "workspace-write";
  if (value === "dangerFullAccess") return "danger-full-access";
  if (value === "readOnly") return "read-only";
  if (value === "workspace-write" || value === "danger-full-access" || value === "read-only") return value;
  return undefined;
}

function sdkApprovalPolicy(value: unknown) {
  if (value === "reject" || value === "never") return "never";
  if (value === "on_request" || value === "on-request") return "on-request";
  if (value === "on_failure" || value === "on-failure") return "on-failure";
  if (value === "untrusted") return "untrusted";
  return undefined;
}

function sdkEventError(event: Record<string, any>) {
  const raw = event.error ?? event;
  return {
    type: "RunnerError",
    code: event.type === "turn.failed" ? "CODEX_SDK_TURN_FAILED" : "CODEX_SDK_ERROR",
    message: raw.message ?? String(raw)
  };
}

function sdkTurnFailure(turn: Record<string, any>, code: string, message: string) {
  return {
    type: "TurnResult",
    status: "failed",
    session_id: turn.session_id,
    thread_id: turn.thread_id,
    turn_id: turn.turn_id,
    error: { type: "RunnerError", code, message }
  };
}

function withoutUndefined<T extends Record<string, any>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
