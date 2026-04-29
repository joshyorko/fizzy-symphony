import test from "node:test";
import assert from "node:assert/strict";

import { createCodexCliAppServerRunner } from "../src/runner-contract.js";

test("Codex CLI app-server runner detects command/version and validates with initialize handshake", async () => {
  const transports = [];
  const runner = createCodexCliAppServerRunner({
    versionProbe: async (command) => ({ ok: true, command_path: `/usr/bin/${command}`, version: "codex-cli 0.125.0" }),
    transportFactory: (options) => {
      const transport = new FakeTransport(options, {
        "initialize": () => ({
          userAgent: "fizzy-symphony/0.125.0",
          codexHome: "/home/test/.codex",
          platformFamily: "unix",
          platformOs: "linux"
        })
      });
      transports.push(transport);
      return transport;
    }
  });
  const config = {
    preferred: "cli_app_server",
    fallback: "cli_app_server",
    cli_app_server: { command: "codex", args: ["app-server"] }
  };
  const workspace = { path: "/tmp/card-workspace" };

  assert.deepEqual(await runner.detect(config), {
    kind: "cli_app_server",
    implementation: "CodexCliAppServerRunner",
    available: true,
    command: "codex",
    argv: ["codex", "app-server"],
    command_path: "/usr/bin/codex",
    version: "codex-cli 0.125.0",
    protocol: {
      source: "codex app-server generate-ts",
      version: "0.125.0",
      methods: ["initialize", "thread/start", "turn/start", "turn/interrupt", "thread/unsubscribe", "thread/archive"]
    }
  });

  const validation = await runner.validate(config, workspace);
  assert.equal(validation.ok, true);
  assert.equal(validation.kind, "cli_app_server");
  assert.equal(validation.workspace, "/tmp/card-workspace");
  assert.deepEqual(validation.argv, ["codex", "app-server"]);
  assert.equal(validation.handshake.ok, true);
  assert.equal(transports[0].options.cwd, "/tmp/card-workspace");
  assert.equal(transports[0].requests[0].method, "initialize");
  assert.equal(transports[0].closed, true);
});

test("Codex CLI app-server runner starts sessions and turns in the prepared workspace", async () => {
  const transport = new FakeTransport({}, {
    "initialize": () => ({
      userAgent: "fizzy-symphony/0.125.0",
      codexHome: "/home/test/.codex",
      platformFamily: "unix",
      platformOs: "linux"
    }),
    "thread/start": (_params) => ({
      thread: {
        id: "thread_1",
        cwd: "/tmp/card-workspace",
        status: "running",
        turns: []
      },
      model: "gpt-5.4",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/tmp/card-workspace",
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite" },
      permissionProfile: null,
      reasoningEffort: null
    }),
    "turn/start": (_params) => ({
      turn: {
        id: "turn_1",
        status: "inProgress",
        items: [],
        error: null,
        startedAt: 1,
        completedAt: null,
        durationMs: null
      }
    })
  });
  const runner = createCodexCliAppServerRunner({
    versionProbe: async () => ({ ok: true, version: "codex-cli 0.125.0" }),
    transportFactory: () => transport,
    now: () => "2026-04-29T19:15:00.000Z"
  });
  const config = runnerConfig();

  const session = await runner.startSession("/tmp/card-workspace", { config, route: { model: "gpt-5.4" } }, { run_id: "run_1" });
  const turn = await runner.startTurn(session, "Implement the card.", { run_id: "run_1", attempt_number: 2 });

  assert.equal(session.session_id, "thread_1");
  assert.equal(session.thread_id, "thread_1");
  assert.equal(session.workspace, "/tmp/card-workspace");
  assert.equal(session.process_owned, true);
  assert.equal(session.process_id, 4321);
  assert.equal(turn.turn_id, "turn_1");
  assert.equal(turn.thread_id, "thread_1");
  assert.equal(turn.workspace, "/tmp/card-workspace");
  assert.equal(turn.prompt_digest.length, 64);

  assert.equal(transport.requests[1].method, "thread/start");
  assert.equal(transport.requests[1].params.cwd, "/tmp/card-workspace");
  assert.equal(transport.requests[1].params.model, "gpt-5.4");
  assert.equal(transport.requests[1].params.approvalPolicy, "on-request");
  assert.equal(transport.requests[1].params.approvalsReviewer, "user");
  assert.equal(transport.requests[1].params.sandbox, "workspace-write");

  assert.equal(transport.requests[2].method, "turn/start");
  assert.deepEqual(transport.requests[2].params.input, [{ type: "text", text: "Implement the card.", text_elements: [] }]);
  assert.equal(transport.requests[2].params.cwd, "/tmp/card-workspace");
  assert.equal(transport.requests[2].params.sandboxPolicy.type, "workspaceWrite");
  assert.deepEqual(transport.requests[2].params.sandboxPolicy.writableRoots, ["/tmp/card-workspace"]);
});

test("Codex CLI app-server runner streams normalized activity and final turn result", async () => {
  const transport = new FakeTransport({}, {
    "initialize": () => initializeResult(),
    "thread/start": () => threadStartResult(),
    "turn/start": () => turnStartResult()
  });
  const runner = createCodexCliAppServerRunner({ transportFactory: () => transport });
  const session = await runner.startSession("/tmp/card-workspace", { config: runnerConfig() }, { run_id: "run_1" });
  const turn = await runner.startTurn(session, "prompt", { run_id: "run_1", attempt_number: 1 });
  const streamed = [];

  const resultPromise = runner.stream(turn, (event) => streamed.push(event));
  transport.emitNotification({ method: "turn/started", params: { threadId: "thread_1", turn: { id: "turn_1", status: "inProgress" } } });
  transport.emitNotification({ method: "item/agentMessage/delta", params: { threadId: "thread_1", turnId: "turn_1", delta: "done" } });
  transport.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "thread_1",
      turn: { id: "turn_1", status: "completed", items: [], error: null, startedAt: 1, completedAt: 2, durationMs: 1000 }
    }
  });

  const result = await resultPromise;
  assert.equal(result.type, "TurnResult");
  assert.equal(result.success, true);
  assert.equal(result.status, "completed");
  assert.equal(result.session_id, "thread_1");
  assert.equal(result.thread_id, "thread_1");
  assert.equal(result.turn_id, "turn_1");
  assert.deepEqual(streamed.map((event) => event.type), ["turn.started", "assistant.delta", "turn.completed"]);
  assert.equal(streamed[1].text, "done");
});

test("Codex CLI app-server runner treats approval and input requests as controlled unattended failures", async () => {
  const transport = new FakeTransport({}, {
    "initialize": () => initializeResult(),
    "thread/start": () => threadStartResult(),
    "turn/start": () => turnStartResult(),
    "turn/interrupt": () => ({})
  });
  const runner = createCodexCliAppServerRunner({ transportFactory: () => transport });
  const session = await runner.startSession("/tmp/card-workspace", { config: runnerConfig() }, { run_id: "run_1" });
  const turn = await runner.startTurn(session, "prompt", { run_id: "run_1" });
  const streamed = [];

  const resultPromise = runner.stream(turn, (event) => streamed.push(event));
  await transport.emitServerRequest({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_1", turnId: "turn_1", itemId: "item_1", command: "deploy" }
  });

  const result = await resultPromise;
  assert.equal(result.status, "failed");
  assert.equal(result.failure_kind, "input_required");
  assert.equal(result.error.code, "RUNNER_INPUT_REQUIRED");
  assert.equal(result.error.retryable, false);
  assert.match(result.error.remediation, /approval/i);
  assert.equal(streamed[0].type, "runner.input_required");
  assert.deepEqual(transport.responses[0], { id: 42, result: { decision: "cancel" } });
  assert.deepEqual(transport.requests.at(-1), {
    method: "turn/interrupt",
    params: { threadId: "thread_1", turnId: "turn_1" }
  });
});

test("Codex CLI app-server runner cancels, stops sessions, and only terminates owned app-server processes", async () => {
  const transport = cancellableTransport();
  const runner = createCodexCliAppServerRunner({ transportFactory: () => transport });
  const session = await runner.startSession("/tmp/card-workspace", { config: runnerConfig() }, { run_id: "run_1" });
  const turn = await runner.startTurn(session, "prompt", { run_id: "run_1" });

  assert.deepEqual(await runner.cancel(turn, "card_closed"), {
    type: "CancelResult",
    status: "cancelled",
    success: true,
    interrupted: true,
    session_stopped: false,
    process_killed: false,
    session_id: "thread_1",
    thread_id: "thread_1",
    turn_id: "turn_1",
    reason: "card_closed"
  });
  assert.deepEqual(await runner.stopSession(session), {
    type: "StopSessionResult",
    status: "stopped",
    success: true,
    session_id: "thread_1",
    thread_id: "thread_1"
  });
  assert.deepEqual(transport.requests.slice(-3).map((request) => request.method), [
    "turn/interrupt",
    "thread/unsubscribe",
    "thread/archive"
  ]);

  const terminatingTransport = cancellableTransport();
  const terminatingRunner = createCodexCliAppServerRunner({ transportFactory: () => terminatingTransport });
  const terminatingSession = await terminatingRunner.startSession("/tmp/card-workspace", { config: runnerConfig() }, { run_id: "run_2" });

  assert.deepEqual(await terminatingRunner.terminateOwnedProcess({ ...terminatingSession, process_owned: false }), {
    type: "TerminateProcessResult",
    status: "unknown_ownership",
    success: false,
    session_id: "thread_1",
    thread_id: "thread_1",
    remediation: "Process ownership is unknown; preserve the workspace and terminate manually after inspection."
  });

  assert.equal((await terminatingRunner.terminateOwnedProcess(terminatingSession)).status, "terminated");
  assert.deepEqual(terminatingTransport.terminations[0], { termTimeoutMs: 5000, killTimeoutMs: 2000 });
});

function cancellableTransport() {
  return new FakeTransport({}, {
    "initialize": () => initializeResult(),
    "thread/start": () => threadStartResult(),
    "turn/start": () => turnStartResult(),
    "turn/interrupt": () => ({}),
    "thread/unsubscribe": () => ({ status: "unsubscribed" }),
    "thread/archive": () => ({})
  });
}

function runnerConfig(overrides = {}) {
  return {
    runner: {
      preferred: "cli_app_server",
      fallback: "cli_app_server",
      cli_app_server: { command: "codex", args: ["app-server"] },
      codex: {
        approval_policy: { mode: "reject" },
        interactive: false,
        thread_sandbox: "workspace-write",
        turn_sandbox_policy: { type: "workspaceWrite" }
      },
      ...overrides.runner
    },
    agent: {
      default_model: "",
      ...overrides.agent
    }
  };
}

function initializeResult() {
  return {
    userAgent: "fizzy-symphony/0.125.0",
    codexHome: "/home/test/.codex",
    platformFamily: "unix",
    platformOs: "linux"
  };
}

function threadStartResult() {
  return {
    thread: { id: "thread_1", cwd: "/tmp/card-workspace", status: "running", turns: [] },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp/card-workspace",
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite" },
    permissionProfile: null,
    reasoningEffort: null
  };
}

function turnStartResult() {
  return {
    turn: {
      id: "turn_1",
      status: "inProgress",
      items: [],
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null
    }
  };
}

class FakeTransport {
  constructor(options = {}, handlers = {}) {
    this.options = options;
    this.handlers = handlers;
    this.requests = [];
    this.responses = [];
    this.notifications = [];
    this.terminations = [];
    this.closed = false;
    this.child = { pid: 4321 };
  }

  async request(method, params) {
    this.requests.push({ method, params });
    const handler = this.handlers[method];
    if (!handler) throw new Error(`Unexpected request ${method}`);
    return handler(params);
  }

  onNotification(handler) {
    this.notificationHandler = handler;
    return () => {
      this.notificationHandler = null;
    };
  }

  onServerRequest(handler) {
    this.serverRequestHandler = handler;
    return () => {
      this.serverRequestHandler = null;
    };
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  respondError(id, error) {
    this.responses.push({ id, error });
  }

  emitNotification(message) {
    this.notifications.push(message);
    this.notificationHandler?.(message);
  }

  async emitServerRequest(message) {
    await this.serverRequestHandler?.(message);
  }

  async close() {
    this.closed = true;
  }

  async terminate(options) {
    this.terminations.push(options);
    return { status: "terminated", signal: "SIGTERM" };
  }
}
