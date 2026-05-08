import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { launchCodexAppServerTransport } from "./codex-app-server-transport.js";
import { redact } from "./logger.js";

const execFile = promisify(nodeExecFile);

const IMPLEMENTATION = "CodexCliAppServerRunner";
const KIND = "cli_app_server";
const PROTOCOL_VERSION = "0.125.0";
const PROTOCOL_METHODS = ["initialize", "thread/start", "turn/start", "turn/interrupt", "thread/unsubscribe"];
const REQUEST_METHODS_REQUIRING_OPERATOR = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "applyPatchApproval",
  "execCommandApproval"
]);

const DEFAULTS = {
  initializeTimeoutMs: 10000,
  requestTimeoutMs: 60000,
  cancelTimeoutMs: 10000,
  stopSessionTimeoutMs: 10000,
  termTimeoutMs: 5000,
  killTimeoutMs: 2000,
  streamTimeoutMs: 0
};

export function createCodexCliAppServerRunner(options = {}) {
  const sessions = new Map();
  const transportFactory = options.transportFactory ?? ((transportOptions) => launchCodexAppServerTransport(transportOptions));
  const versionProbe = options.versionProbe ?? ((command, probeOptions) => probeCodexVersion(command, {
    execFile: options.execFile,
    timeoutMs: probeOptions?.timeoutMs
  }));
  const now = options.now ?? (() => new Date().toISOString());

  const runner = {
    async detect(config = {}) {
      const runnerConfig = resolveRunnerConfig(config);
      const command = runnerConfig.cli_app_server.command;
      const args = runnerConfig.cli_app_server.args;
      const probe = await versionProbe(command, { timeoutMs: runnerConfig.detect_timeout_ms });
      const report = omitUndefined({
        kind: KIND,
        implementation: IMPLEMENTATION,
        available: probe.ok !== false,
        command,
        argv: [command, ...args],
        command_path: probe.command_path,
        version: probe.version,
        protocol: protocolReport(),
        reason: probe.ok === false ? probe.reason ?? probe.message : undefined,
        remediation: probe.ok === false
          ? `Install or expose the Codex CLI executable '${command}', then rerun setup or startup validation.`
          : undefined
      });
      return report;
    },

    async validate(config = {}, workspace = null) {
      const runnerConfig = resolveRunnerConfig(config);
      const workspaceInfo = await workspaceForValidation(workspace);
      let transport;

      try {
        transport = transportFactory(transportOptions(runnerConfig, workspaceInfo.path));
        const handshake = await initializeTransport(transport, runnerConfig);
        return {
          ok: true,
          kind: KIND,
          implementation: IMPLEMENTATION,
          workspace: workspaceInfo.path,
          argv: [runnerConfig.cli_app_server.command, ...runnerConfig.cli_app_server.args],
          policy_payload_valid: true,
          smoke_turn_skipped: true,
          handshake: {
            ok: true,
            user_agent: handshake.userAgent,
            platform_os: handshake.platformOs,
            platform_family: handshake.platformFamily
          },
          warnings: ["Model-consuming smoke turn skipped by default."]
        };
      } catch (error) {
        return {
          ok: false,
          kind: KIND,
          implementation: IMPLEMENTATION,
          workspace: workspaceInfo.path,
          argv: [runnerConfig.cli_app_server.command, ...runnerConfig.cli_app_server.args],
          handshake: {
            ok: false,
            error: normalizeRunnerError(error, "APP_SERVER_HANDSHAKE_FAILED")
          },
          remediation: "Confirm `codex app-server --listen stdio://` starts locally and Codex authentication/configuration is present."
        };
      } finally {
        await transport?.close?.();
        if (workspaceInfo.temporary) {
          await rm(workspaceInfo.path, { recursive: true, force: true });
        }
      }
    },

    async health(config = {}) {
      const checkedAt = now();
      const validation = await runner.validate(config, null);
      if (validation.ok) {
        return {
          status: "ready",
          readiness_effect: "ready",
          kind: KIND,
          implementation: IMPLEMENTATION,
          checked_at: checkedAt,
          version: validation.handshake?.user_agent,
          protocol: protocolReport(),
          smoke_turn_skipped: true
        };
      }

      return {
        status: "unavailable",
        readiness_effect: "blocks_dispatch",
        kind: KIND,
        implementation: IMPLEMENTATION,
        checked_at: checkedAt,
        failure_code: validation.handshake?.error?.code ?? "APP_SERVER_HEALTH_FAILED",
        failure_message: validation.handshake?.error?.message ?? "Codex app-server health check failed.",
        remediation: validation.remediation
      };
    },

    async startSession(workspace, policies = {}, metadata = {}) {
      const runnerConfig = resolveRunnerConfig(policies.config ?? policies.runner ?? {});
      const path = workspacePath(workspace);
      const transport = transportFactory(transportOptions(runnerConfig, path));
      const context = createSessionContext({ transport, runnerConfig, now });
      wireTransportContext(context);

      try {
        const handshake = await initializeTransport(transport, runnerConfig);
        const threadStart = await transport.request(
          "thread/start",
          threadStartParams({ path, policies, metadata, runnerConfig }),
          { timeoutMs: timeoutValue(runnerConfig, "requestTimeoutMs") }
        );
        const thread = threadStart.thread ?? {};
        const sessionId = thread.id;
        const executionEnvironment = executionEnvironmentFor({ path, threadStart, metadata });
        const session = omitUndefined({
          type: "Session",
          session_id: sessionId,
          thread_id: sessionId,
          kind: KIND,
          implementation: IMPLEMENTATION,
          process_id: transport.child?.pid,
          process_owned: true,
          workspace: path,
          workspace_path: path,
          execution_environment: executionEnvironment,
          started_at: now(),
          policies: serializablePolicies(policies),
          metadata,
          model_selection: modelSelection({ threadStart, policies, metadata }),
          app_server: {
            user_agent: handshake.userAgent,
            platform_os: handshake.platformOs,
            protocol: protocolReport()
          }
        });
        context.session = session;
        sessions.set(sessionId, context);
        return session;
      } catch (error) {
        await transport.close?.();
        throw error;
      }
    },

    async startTurn(session, prompt, metadata = {}) {
      const context = sessions.get(session.session_id);
      if (!context) throw runnerError("APP_SERVER_SESSION_NOT_FOUND", "Codex app-server session is not active.", { session_id: session.session_id });
      const runnerConfig = context.runnerConfig;
      const response = await context.transport.request(
        "turn/start",
        turnStartParams({ session, prompt, metadata, runnerConfig }),
        { timeoutMs: timeoutValue(runnerConfig, "requestTimeoutMs") }
      );
      const turn = response.turn ?? {};

      return omitUndefined({
        type: "Turn",
        run_id: metadata.run_id,
        attempt_number: metadata.attempt_number,
        session_id: session.session_id,
        thread_id: session.thread_id,
        turn_id: turn.id,
        started_at: now(),
        prompt_digest: sha256(prompt),
        workspace: session.workspace_path ?? session.workspace,
        workspace_path: session.workspace_path ?? session.workspace,
        execution_environment: session.execution_environment,
        metadata,
        runner: {
          kind: KIND,
          implementation: IMPLEMENTATION,
          protocol: protocolReport()
        }
      });
    },

    async stream(turn, onEvent) {
      const context = sessions.get(turn.session_id);
      if (!context) {
        return turnFailure(turn, "runner_error", normalizeRunnerError(
          runnerError("APP_SERVER_SESSION_NOT_FOUND", "Codex app-server session is not active."),
          "APP_SERVER_SESSION_NOT_FOUND"
        ));
      }

      const emitted = [];
      let timeout;
      try {
        const streamTimeoutMs = timeoutValue(context.runnerConfig, "streamTimeoutMs");
        if (streamTimeoutMs > 0) {
          timeout = setTimeout(() => {
            context.streamFailure = {
              failure_kind: "timed_out",
              error: normalizeRunnerError(
                runnerError("APP_SERVER_STREAM_TIMEOUT", "Codex app-server stream timed out.", { timeout_ms: streamTimeoutMs }),
                "APP_SERVER_STREAM_TIMEOUT"
              )
            };
            wake(context);
          }, streamTimeoutMs);
        }

        while (true) {
          if (context.inputRequired) {
            const event = inputRequiredEvent(turn, context.inputRequired);
            emitted.push(event);
            onEvent?.(event);
            await this.cancel(turn, "input_required");
            return turnFailure(turn, "input_required", context.inputRequired.error, emitted);
          }

          if (context.streamFailure) {
            return turnFailure(turn, context.streamFailure.failure_kind, context.streamFailure.error, emitted);
          }

          const next = shiftMatchingNotification(context, turn);
          if (next) {
            const event = normalizeNotification(next, turn, now);
            emitted.push(event);
            onEvent?.(event);
            if (event.type === "assistant.delta" && event.text) {
              context.output += event.text;
            }
            if (event.final) return turnResultFromFinal(turn, event, emitted, context.output);
            continue;
          }

          await waitForContext(context);
        }
      } finally {
        clearTimeout(timeout);
      }
    },

    async cancel(turn, reason = "cancelled") {
      const context = sessions.get(turn.session_id);
      if (!context) {
        return cancelFailure(turn, reason, "APP_SERVER_SESSION_NOT_FOUND", "Codex app-server session is not active.");
      }

      try {
        await context.transport.request("turn/interrupt", {
          threadId: turn.thread_id,
          turnId: turn.turn_id
        }, { timeoutMs: timeoutValue(context.runnerConfig, "cancelTimeoutMs") });
        return {
          type: "CancelResult",
          status: "cancelled",
          success: true,
          interrupted: true,
          session_stopped: false,
          process_killed: false,
          session_id: turn.session_id,
          thread_id: turn.thread_id,
          turn_id: turn.turn_id,
          reason
        };
      } catch (error) {
        const normalized = normalizeRunnerError(error, "APP_SERVER_CANCEL_FAILED");
        return {
          type: "CancelResult",
          status: normalized.code === "APP_SERVER_REQUEST_TIMEOUT" ? "timeout" : "failed",
          success: false,
          interrupted: false,
          session_stopped: false,
          process_killed: false,
          session_id: turn.session_id,
          thread_id: turn.thread_id,
          turn_id: turn.turn_id,
          reason,
          error: normalized
        };
      }
    },

    async stopSession(session) {
      const context = sessions.get(session.session_id);
      if (!context) {
        return {
          type: "StopSessionResult",
          status: "failed",
          success: false,
          session_id: session.session_id,
          thread_id: session.thread_id,
          error: normalizeRunnerError(
            runnerError("APP_SERVER_SESSION_NOT_FOUND", "Codex app-server session is not active."),
            "APP_SERVER_SESSION_NOT_FOUND"
          )
        };
      }

      try {
        await context.transport.request("thread/unsubscribe", { threadId: session.thread_id }, {
          timeoutMs: timeoutValue(context.runnerConfig, "stopSessionTimeoutMs")
        });
        const closeResult = await context.transport.close?.({
          timeoutMs: timeoutValue(context.runnerConfig, "stopSessionTimeoutMs")
        });
        if (closeResult && !["closed", "terminated"].includes(closeResult.status)) {
          return {
            type: "StopSessionResult",
            status: "failed",
            success: false,
            session_id: session.session_id,
            thread_id: session.thread_id,
            close_result: closeResult,
            error: normalizeRunnerError(
              runnerError("APP_SERVER_CLOSE_INCOMPLETE", "Codex app-server session unsubscribe completed, but the process did not close."),
              "APP_SERVER_CLOSE_INCOMPLETE"
            )
          };
        }
        sessions.delete(session.session_id);
        return {
          type: "StopSessionResult",
          status: "stopped",
          success: true,
          session_id: session.session_id,
          thread_id: session.thread_id,
          close_result: closeResult
        };
      } catch (error) {
        return {
          type: "StopSessionResult",
          status: "failed",
          success: false,
          session_id: session.session_id,
          thread_id: session.thread_id,
          error: normalizeRunnerError(error, "APP_SERVER_STOP_SESSION_FAILED")
        };
      }
    },

    async terminateOwnedProcess(session) {
      if (session.process_owned !== true) {
        return {
          type: "TerminateProcessResult",
          status: "unknown_ownership",
          success: false,
          session_id: session.session_id,
          thread_id: session.thread_id,
          remediation: "Process ownership is unknown; preserve the workspace and terminate manually after inspection."
        };
      }

      const context = sessions.get(session.session_id);
      if (!context) {
        return {
          type: "TerminateProcessResult",
          status: "failed",
          success: false,
          session_id: session.session_id,
          thread_id: session.thread_id,
          error: normalizeRunnerError(
            runnerError("APP_SERVER_SESSION_NOT_FOUND", "Codex app-server session is not active."),
            "APP_SERVER_SESSION_NOT_FOUND"
          )
        };
      }

      const result = await context.transport.terminate?.({
        termTimeoutMs: timeoutValue(context.runnerConfig, "termTimeoutMs"),
        killTimeoutMs: timeoutValue(context.runnerConfig, "killTimeoutMs")
      });
      sessions.delete(session.session_id);
      return {
        type: "TerminateProcessResult",
        status: result?.status === "terminated" ? "terminated" : "failed",
        success: result?.status === "terminated",
        session_id: session.session_id,
        thread_id: session.thread_id,
        process_id: session.process_id,
        signal: result?.signal,
        error: result?.error
      };
    }
  };
  return runner;
}

async function initializeTransport(transport, runnerConfig) {
  return transport.request("initialize", {
    clientInfo: {
      name: "fizzy-symphony",
      title: "Fizzy Symphony",
      version: "0.1.0"
    },
    capabilities: {
      experimentalApi: true
    }
  }, { timeoutMs: timeoutValue(runnerConfig, "initializeTimeoutMs") });
}

function createSessionContext({ transport, runnerConfig, now }) {
  return {
    transport,
    runnerConfig,
    now,
    session: null,
    notifications: [],
    output: "",
    waiters: [],
    inputRequired: null,
    streamFailure: null
  };
}

function wireTransportContext(context) {
  context.transport.onNotification?.((message) => {
    context.notifications.push(message);
    wake(context);
  });
  context.transport.onServerRequest?.((message) => handleServerRequest(context, message));
  context.transport.onExit?.((exit) => {
    context.streamFailure = {
      failure_kind: "runner_error",
      error: normalizeRunnerError(
        runnerError("APP_SERVER_EXITED", "Codex app-server exited before the turn completed.", exit),
        "APP_SERVER_EXITED"
      )
    };
    wake(context);
  });
  context.transport.onProtocolError?.((error) => {
    context.streamFailure = {
      failure_kind: "runner_error",
      error: normalizeRunnerError(error, "APP_SERVER_PROTOCOL_ERROR")
    };
    wake(context);
  });
}

function handleServerRequest(context, message) {
  const inputRequired = inputRequiredFailure(message);
  context.inputRequired = inputRequired;

  if (message.id !== undefined) {
    const response = serverRequestRejection(message);
    if (response.error) {
      context.transport.respondError?.(message.id, response.error);
    } else {
      context.transport.respond?.(message.id, response.result);
    }
  }

  wake(context);
}

function serverRequestRejection(message) {
  switch (message.method) {
    case "item/commandExecution/requestApproval":
      return { result: { decision: "cancel" } };
    case "item/fileChange/requestApproval":
      return { result: { decision: "cancel" } };
    case "item/tool/requestUserInput":
      return { result: { answers: {} } };
    case "mcpServer/elicitation/request":
      return { result: { action: "cancel", content: null, _meta: null } };
    case "item/permissions/requestApproval":
      return { result: { permissions: {}, scope: "turn" } };
    case "item/tool/call":
      return { result: { contentItems: [], success: false } };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { result: { decision: "abort" } };
    case "account/chatgptAuthTokens/refresh":
      return {
        error: runnerError(
          "RUNNER_INPUT_REQUIRED",
          "Codex app-server requested ChatGPT token refresh in unattended mode."
        )
      };
    default:
      return {
        error: runnerError("APP_SERVER_UNHANDLED_REQUEST", `Unhandled Codex app-server server request: ${message.method}.`)
      };
  }
}

function inputRequiredFailure(message) {
  const method = message.method;
  const kind = REQUEST_METHODS_REQUIRING_OPERATOR.has(method) ? "approval/input request" : "server request";
  return {
    method,
    thread_id: message.params?.threadId ?? message.params?.conversationId,
    turn_id: message.params?.turnId,
    error: {
      type: "RunnerError",
      code: "RUNNER_INPUT_REQUIRED",
      message: `Codex app-server requested an operator ${kind} in unattended mode.`,
      remediation: "Review the card workspace, adjust runner.codex approval/input policy or run Codex interactively, then rerun the card.",
      retryable: false,
      raw_error: {
        method,
        params: redact(safeParams(message.params))
      }
    }
  };
}

function inputRequiredEvent(turn, failure) {
  return {
    type: "runner.input_required",
    method: failure.method,
    timestamp: new Date().toISOString(),
    session_id: turn.session_id,
    thread_id: failure.thread_id ?? turn.thread_id,
    turn_id: failure.turn_id ?? turn.turn_id,
    error: failure.error
  };
}

function normalizeNotification(message, turn, now) {
  const params = message.params ?? {};
  const base = {
    type: methodToEventType(message.method),
    method: message.method,
    timestamp: now(),
    session_id: turn.session_id,
    thread_id: params.threadId ?? turn.thread_id,
    turn_id: params.turnId ?? params.turn?.id ?? turn.turn_id
  };

  if (message.method === "item/agentMessage/delta") {
    return omitUndefined({
      ...base,
      type: "assistant.delta",
      text: params.delta ?? params.text
    });
  }

  if (message.method === "turn/completed") {
    return omitUndefined({
      ...base,
      type: "turn.completed",
      final: true,
      status: normalizeTurnStatus(params.turn?.status),
      error: params.turn?.error ? normalizeTurnError(params.turn.error) : undefined,
      duration_ms: params.turn?.durationMs
    });
  }

  if (message.method === "error") {
    return omitUndefined({
      ...base,
      type: "turn.error",
      final: true,
      status: "failed",
      error: normalizeTurnError(params.error),
      retryable: params.willRetry
    });
  }

  if (message.method === "thread/tokenUsage/updated") {
    return omitUndefined({
      ...base,
      type: "runner.token_usage",
      token_usage: redact(params.usage ?? params.tokenUsage)
    });
  }

  return omitUndefined({
    ...base,
    status: normalizeTurnStatus(params.turn?.status ?? params.status),
    safe_payload: redact(safeParams(params))
  });
}

function turnResultFromFinal(turn, event, events, output) {
  const success = event.status === "completed";
  return omitUndefined({
    type: "TurnResult",
    success,
    status: event.status,
    session_id: turn.session_id,
    thread_id: turn.thread_id,
    turn_id: turn.turn_id,
    output_summary: output ? output.slice(0, 4000) : undefined,
    events,
    error: success ? undefined : event.error ?? {
      type: "RunnerError",
      code: "RUNNER_TURN_FAILED",
      message: `Codex turn ended with status ${event.status}.`,
      remediation: "Inspect the workspace and runner events before retrying.",
      retryable: true
    }
  });
}

function turnFailure(turn, failureKind, error, events = []) {
  return {
    type: "TurnResult",
    success: false,
    status: "failed",
    session_id: turn.session_id,
    thread_id: turn.thread_id,
    turn_id: turn.turn_id,
    failure_kind: failureKind,
    events,
    error
  };
}

function cancelFailure(turn, reason, code, message) {
  return {
    type: "CancelResult",
    status: "failed",
    success: false,
    interrupted: false,
    session_stopped: false,
    process_killed: false,
    session_id: turn.session_id,
    thread_id: turn.thread_id,
    turn_id: turn.turn_id,
    reason,
    error: normalizeRunnerError(runnerError(code, message), code)
  };
}

function shiftMatchingNotification(context, turn) {
  const index = context.notifications.findIndex((message) => {
    const params = message.params ?? {};
    const threadId = params.threadId ?? params.conversationId;
    const turnId = params.turnId ?? params.turn?.id;
    return (!threadId || threadId === turn.thread_id) && (!turnId || turnId === turn.turn_id);
  });
  if (index === -1) return null;
  return context.notifications.splice(index, 1)[0];
}

function waitForContext(context) {
  return new Promise((resolve) => {
    context.waiters.push(resolve);
  });
}

function wake(context) {
  const waiters = context.waiters.splice(0);
  for (const waiter of waiters) waiter();
}

function threadStartParams({ path, policies, metadata, runnerConfig }) {
  const model = metadata.model ?? policies.route?.model ?? policies.config?.agent?.default_model;
  const reasoningEffort = metadata.reasoningEffort ??
    metadata.reasoning_effort ??
    policies.route?.reasoning_effort ??
    policies.config?.agent?.reasoning_effort;
  const configOverrides = omitUndefined({
    model_reasoning_effort: reasoningEffort || undefined
  });
  return omitUndefined({
    model: model || undefined,
    cwd: path,
    approvalPolicy: approvalPolicy(runnerConfig),
    approvalsReviewer: "user",
    sandbox: runnerConfig.codex.thread_sandbox,
    config: configOverrides,
    serviceName: "fizzy-symphony",
    ephemeral: false,
    sessionStartSource: "clear",
    experimentalRawEvents: false,
    persistExtendedHistory: true
  });
}

function executionEnvironmentFor({ path, threadStart, metadata }) {
  const explicit = metadata.execution_environment ?? metadata.executionEnvironment ?? {};
  const cwd = explicit.cwd ?? threadStart.cwd ?? threadStart.thread?.cwd ?? path;
  return omitUndefined({
    id: explicit.id ?? metadata.workspace_key ?? path,
    kind: explicit.kind ?? "local_workspace",
    workspace_path: explicit.workspace_path ?? path,
    cwd
  });
}

function modelSelection({ threadStart, policies, metadata }) {
  const requestedModel = metadata.model ?? policies.route?.model ?? policies.config?.agent?.default_model;
  const requestedReasoningEffort = metadata.reasoningEffort ??
    metadata.reasoning_effort ??
    policies.route?.reasoning_effort ??
    policies.config?.agent?.reasoning_effort;
  const profile = metadata.model_profile ?? policies.route?.model_profile ?? policies.route?.model_metadata;
  return omitUndefined({
    model: threadStart.model ?? requestedModel,
    provider: threadStart.modelProvider,
    service_tier: threadStart.serviceTier,
    reasoning_effort: threadStart.reasoningEffort ?? requestedReasoningEffort,
    model_profile: profile
  });
}

function turnStartParams({ session, prompt, metadata, runnerConfig }) {
  return omitUndefined({
    threadId: session.thread_id,
    input: [{ type: "text", text: String(prompt ?? ""), text_elements: [] }],
    cwd: session.workspace_path ?? session.workspace,
    approvalPolicy: approvalPolicy(runnerConfig),
    approvalsReviewer: "user",
    sandboxPolicy: sandboxPolicy(runnerConfig, session.workspace_path ?? session.workspace),
    model: metadata.model || undefined
  });
}

function approvalPolicy(runnerConfig) {
  if (runnerConfig.codex.interactive === true) return "on-request";
  return "on-request";
}

function sandboxPolicy(runnerConfig, path) {
  const type = runnerConfig.codex.turn_sandbox_policy?.type ?? "workspaceWrite";
  if (type === "dangerFullAccess") return { type: "dangerFullAccess" };
  if (type === "readOnly") {
    return {
      type: "readOnly",
      access: { type: "restricted", includePlatformDefaults: true, readableRoots: [path] },
      networkAccess: false
    };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [path],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function transportOptions(runnerConfig, cwd) {
  return {
    command: runnerConfig.cli_app_server.command,
    args: runnerConfig.cli_app_server.args,
    cwd,
    maxStderrBytes: runnerConfig.max_stderr_bytes
  };
}

function resolveRunnerConfig(config = {}) {
  const runner = config.runner ?? config;
  return {
    preferred: runner.preferred ?? "cli_app_server",
    fallback: runner.fallback ?? "cli_app_server",
    cli_app_server: {
      command: runner.cli_app_server?.command ?? "codex",
      args: runner.cli_app_server?.args ?? ["app-server"]
    },
    codex: {
      interactive: runner.codex?.interactive === true,
      approval_policy: runner.codex?.approval_policy ?? { mode: "reject" },
      thread_sandbox: runner.codex?.thread_sandbox ?? "workspace-write",
      turn_sandbox_policy: runner.codex?.turn_sandbox_policy ?? { type: "workspaceWrite" }
    },
    timeouts: {
      initializeTimeoutMs: runner.initialize_timeout_ms ?? DEFAULTS.initializeTimeoutMs,
      requestTimeoutMs: runner.request_timeout_ms ?? DEFAULTS.requestTimeoutMs,
      cancelTimeoutMs: runner.cancel_timeout_ms ?? DEFAULTS.cancelTimeoutMs,
      stopSessionTimeoutMs: runner.stop_session_timeout_ms ?? DEFAULTS.stopSessionTimeoutMs,
      termTimeoutMs: runner.terminate_timeout_ms ?? DEFAULTS.termTimeoutMs,
      killTimeoutMs: runner.kill_timeout_ms ?? DEFAULTS.killTimeoutMs,
      streamTimeoutMs: config.agent?.turn_timeout_ms ?? runner.stream_timeout_ms ?? DEFAULTS.streamTimeoutMs
    },
    detect_timeout_ms: runner.detect_timeout_ms,
    max_stderr_bytes: runner.max_stderr_bytes
  };
}

function timeoutValue(runnerConfig, key) {
  return Number(runnerConfig.timeouts?.[key] ?? DEFAULTS[key] ?? 0);
}

async function workspaceForValidation(workspace) {
  const path = workspacePath(workspace);
  if (path) return { path, temporary: false };
  const temporary = await mkdtemp(join(tmpdir(), "fizzy-symphony-codex-health-"));
  return { path: temporary, temporary: true };
}

function workspacePath(workspace) {
  if (typeof workspace === "string") return workspace;
  return workspace?.path ?? workspace?.workspace_path ?? null;
}

function serializablePolicies(policies) {
  return redact({
    route: policies.route,
    workflow: policies.workflow ? {
      front_matter: policies.workflow.front_matter ?? policies.workflow.frontMatter,
      body_length: String(policies.workflow.body ?? "").length
    } : undefined
  });
}

async function probeCodexVersion(command, options = {}) {
  try {
    const result = await execFile(command, ["--version"], {
      timeout: options.timeoutMs ?? 5000,
      shell: false
    });
    return { ok: true, version: String(result.stdout || result.stderr).trim() };
  } catch (error) {
    return {
      ok: false,
      reason: error.code === "ENOENT" ? "command_not_found" : "version_probe_failed",
      message: error.message
    };
  }
}

function protocolReport() {
  return {
    source: "codex app-server generate-ts",
    version: PROTOCOL_VERSION,
    methods: PROTOCOL_METHODS
  };
}

function normalizeTurnStatus(status) {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "cancelled";
  if (status === "failed") return "failed";
  if (status === "inProgress") return "running";
  return status;
}

function normalizeTurnError(error) {
  if (!error) return undefined;
  return {
    type: "RunnerError",
    code: codexErrorCode(error.codexErrorInfo),
    message: error.message ?? "Codex app-server reported a turn error.",
    remediation: "Inspect the runner events and workspace before retrying.",
    retryable: error.codexErrorInfo !== "unauthorized",
    raw_error: redact(error)
  };
}

function normalizeRunnerError(error, fallbackCode) {
  return {
    type: "RunnerError",
    code: error?.code ?? fallbackCode,
    message: error?.message ?? String(error ?? "Codex runner error."),
    remediation: error?.remediation ?? "Inspect Codex CLI authentication, app-server availability, and the card workspace.",
    retryable: error?.retryable ?? !["RUNNER_INPUT_REQUIRED", "APP_SERVER_SESSION_NOT_FOUND"].includes(error?.code ?? fallbackCode),
    raw_error: redact(error?.details)
  };
}

function runnerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function codexErrorCode(info) {
  if (!info) return "CODEX_TURN_ERROR";
  if (typeof info === "string") return `CODEX_${info.replace(/[A-Z]/gu, (char) => `_${char}`).toUpperCase()}`;
  return `CODEX_${Object.keys(info)[0]?.replace(/[A-Z]/gu, (char) => `_${char}`).toUpperCase() ?? "TURN_ERROR"}`;
}

function methodToEventType(method) {
  switch (method) {
    case "turn/started":
      return "turn.started";
    case "turn/completed":
      return "turn.completed";
    case "thread/started":
      return "session.started";
    default:
      return String(method).replaceAll("/", ".");
  }
}

function safeParams(params = {}) {
  if (!params || typeof params !== "object") return params;
  return omitUndefined({
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    status: params.status,
    command: params.command,
    cwd: params.cwd,
    reason: params.reason,
    message: params.message,
    serverName: params.serverName
  });
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
