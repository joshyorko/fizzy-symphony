import test from "node:test";
import assert from "node:assert/strict";

import { listCapabilities, getCapability, deriveCapabilities } from "../../src/v2/core/capabilities.ts";
import { normalizeStatus } from "../../src/v2/core/status.ts";

test("registry lists capabilities with required shape", () => {
  const capabilities = listCapabilities();
  assert.ok(capabilities.length > 0);
  for (const capability of capabilities) {
    assert.equal(typeof capability.id, "string");
    assert.equal(typeof capability.title, "string");
    assert.equal(typeof capability.category, "string");
    assert.equal(typeof capability.enabled, "boolean");
  }
});

test("getCapability returns a copy, not the registry entry", () => {
  const a = getCapability("codex.run");
  const b = getCapability("codex.run");
  assert.ok(a && b);
  assert.notEqual(a, b);
  a.enabled = false;
  assert.equal(getCapability("codex.run").enabled, true);
});

test("deriveCapabilities disables cancel/stop when no run is active", () => {
  const status = normalizeStatus({
    readiness: { state: "ready", ready: true, runnerStatus: "ready" },
    runs: { running: [] }
  });
  const derived = deriveCapabilities(status);
  const cancel = derived.find((c) => c.id === "codex.cancel");
  const stop = derived.find((c) => c.id === "session.stop");
  assert.equal(cancel.enabled, false);
  assert.equal(cancel.disabledReason, "No active run");
  assert.equal(stop.enabled, false);
});

test("deriveCapabilities disables codex.run when runner not ready", () => {
  const status = normalizeStatus({
    readiness: { state: "blocked", ready: false, runnerStatus: "unavailable" }
  });
  const run = deriveCapabilities(status).find((c) => c.id === "codex.run");
  assert.equal(run.enabled, false);
  assert.equal(run.disabledReason, "Runner not ready");
});

test("deriveCapabilities enables cancel/stop when a run is active", () => {
  const status = normalizeStatus({
    readiness: { state: "ready", ready: true, runnerStatus: "ready" },
    runs: { running: [{ id: "run_1", state: "running", sessionId: "s_1" }] }
  });
  const cancel = deriveCapabilities(status).find((c) => c.id === "codex.cancel");
  assert.equal(cancel.enabled, true);
});
