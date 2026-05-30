import test from "node:test";
import assert from "node:assert/strict";

import { handleApiRequest, createApiServer } from "../../src/v2/daemon/api.ts";
import { createRuntime } from "../../src/v2/daemon/runtime.ts";

function runtimeWithRun() {
  return createRuntime({
    status: {
      instance: { id: "instance-test" },
      readiness: { state: "ready", ready: true, runnerStatus: "ready" },
      runs: { running: [{ id: "run_1", state: "running", sessionId: "s_1", cardId: "card_1" }] },
      cards: [{ id: "card_1", title: "c", boardId: "b", state: "running", golden: false }],
      worktrees: [{ workspaceKey: "ws_1", path: "/ws", dirty: true, preserved: true }]
    }
  });
}

test("handleApiRequest serves read endpoints", () => {
  const runtime = runtimeWithRun();
  assert.equal(handleApiRequest(runtime, "GET", "/v2/health").statusCode, 200);
  assert.equal(handleApiRequest(runtime, "GET", "/v2/ready").statusCode, 200);
  assert.equal(handleApiRequest(runtime, "GET", "/v2/status").body.schemaVersion, "fizzy-symphony-status-v2");
  assert.ok(handleApiRequest(runtime, "GET", "/v2/capabilities").body.capabilities.length > 0);
  assert.ok(Array.isArray(handleApiRequest(runtime, "GET", "/v2/events").body.events));
  assert.ok(handleApiRequest(runtime, "GET", "/v2/runs").body.runs.running.length === 1);
  assert.equal(handleApiRequest(runtime, "GET", "/v2/runs/run_1").body.run.id, "run_1");
  assert.equal(handleApiRequest(runtime, "GET", "/v2/runs/missing").statusCode, 404);
  assert.equal(handleApiRequest(runtime, "GET", "/v2/worktrees").body.worktrees.length, 1);
});

test("ready endpoint returns 503 when not ready", () => {
  const runtime = createRuntime({ status: { readiness: { state: "blocked", ready: false, blockers: [{ code: "X", message: "m" }] } } });
  assert.equal(handleApiRequest(runtime, "GET", "/v2/ready").statusCode, 503);
});

test("command endpoint validates and dry-runs", () => {
  const runtime = runtimeWithRun();
  const accepted = handleApiRequest(runtime, "POST", "/v2/commands", { type: "run.cancel", runId: "run_1", reason: "x" });
  assert.equal(accepted.statusCode, 202);
  assert.equal(accepted.body.outcome, "dry-run");

  const unavailable = handleApiRequest(runtime, "POST", "/v2/commands", { type: "run.cancel", runId: "nope", reason: "x" });
  assert.equal(unavailable.statusCode, 409);

  const rejected = handleApiRequest(runtime, "POST", "/v2/commands", { type: "garbage" });
  assert.equal(rejected.statusCode, 400);
});

test("unknown route returns 404", () => {
  const runtime = runtimeWithRun();
  assert.equal(handleApiRequest(runtime, "GET", "/v2/nope").statusCode, 404);
});

test("createApiServer serves over a real socket", async () => {
  const runtime = runtimeWithRun();
  const api = createApiServer(runtime);
  const { url } = await api.listen();
  try {
    const statusRes = await fetch(`${url}/v2/status`);
    assert.equal(statusRes.status, 200);
    const status = await statusRes.json();
    assert.equal(status.instance.id, "instance-test");

    const cmdRes = await fetch(`${url}/v2/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "run.cancel", runId: "run_1", reason: "operator" })
    });
    assert.equal(cmdRes.status, 202);
    const cmd = await cmdRes.json();
    assert.equal(cmd.outcome, "dry-run");
  } finally {
    await api.close();
  }
});
