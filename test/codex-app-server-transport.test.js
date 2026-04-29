import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { launchCodexAppServerTransport } from "../src/codex-app-server-transport.js";

test("app-server transport launches explicit argv in the workspace without shell eval", async () => {
  const child = new FakeChildProcess();
  const calls = [];
  const transport = launchCodexAppServerTransport({
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
    cwd: "/tmp/card-workspace",
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    }
  });

  assert.equal(calls[0].command, "codex");
  assert.deepEqual(calls[0].args, ["app-server", "--listen", "stdio://"]);
  assert.equal(calls[0].options.cwd, "/tmp/card-workspace");
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "pipe"]);

  await transport.close();
});

test("app-server transport matches JSONL responses, notifications, and server requests", async () => {
  const child = new FakeChildProcess();
  const transport = launchCodexAppServerTransport({
    command: "codex",
    args: ["app-server"],
    cwd: "/tmp/card-workspace",
    spawn: () => child
  });
  const notifications = [];
  const serverRequests = [];
  transport.onNotification((message) => notifications.push(message));
  transport.onServerRequest(async (message) => {
    serverRequests.push(message);
    return { decision: "cancel" };
  });

  const response = transport.request("initialize", { clientInfo: { name: "test" } });
  assert.deepEqual(JSON.parse(child.stdinWrites[0]), {
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "test" } }
  });

  child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread_1" } })}\n`);
  child.stdout.write(`${JSON.stringify({
    id: 99,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread_1", turnId: "turn_1" }
  })}\n`);
  child.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "codex-cli/0.125.0" } })}\n`);

  assert.deepEqual(await response, { userAgent: "codex-cli/0.125.0" });
  assert.equal(notifications[0].method, "turn/started");
  assert.equal(serverRequests[0].method, "item/commandExecution/requestApproval");
  assert.deepEqual(JSON.parse(child.stdinWrites[1]), { id: 99, result: { decision: "cancel" } });

  await transport.close();
});

test("app-server transport rejects pending requests on malformed protocol messages", async () => {
  const child = new FakeChildProcess();
  const transport = launchCodexAppServerTransport({
    command: "codex",
    args: ["app-server"],
    cwd: "/tmp/card-workspace",
    spawn: () => child
  });

  const response = assert.rejects(
    transport.request("initialize", {}),
    /Malformed Codex app-server JSONL message/u
  );
  child.stdout.write("{not json}\n");
  await response;

  await transport.close();
});

test("app-server transport includes bounded stderr when the process exits during a request", async () => {
  const child = new FakeChildProcess();
  const transport = launchCodexAppServerTransport({
    command: "codex",
    args: ["app-server"],
    cwd: "/tmp/card-workspace",
    spawn: () => child,
    maxStderrBytes: 64
  });

  const response = assert.rejects(
    transport.request("initialize", {}),
    (error) => {
      assert.equal(error.code, "APP_SERVER_EXITED");
      assert.match(error.message, /boom/u);
      return true;
    }
  );
  child.stderr.write("boom from app-server\n");
  child.exit(17, null);
  await response;

  await transport.close();
});

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 12345;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdinWrites = [];
    this.killSignals = [];
    this.exitCode = null;
    this.signalCode = null;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.stdinWrites.push(String(chunk).trim());
        callback();
      }
    });
  }

  kill(signal = "SIGTERM") {
    this.killSignals.push(signal);
    return true;
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}
