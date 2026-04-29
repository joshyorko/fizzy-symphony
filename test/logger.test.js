import test from "node:test";
import assert from "node:assert/strict";

import { createLogger } from "../src/logger.js";

test("structured logger emits context fields and redacts sensitive keys and bearer values", () => {
  const lines = [];
  const logger = createLogger({
    context: {
      instance: { id: "instance-a" },
      run: { id: "run_1", attempt_id: "attempt_1" },
      card: { id: "card_1", number: 42 },
      route: { id: "route_1", fingerprint: "sha256:route" },
      workspace: { key: "app", path: "/tmp/workspace" },
      runner: { kind: "cli_app_server" }
    },
    now: () => "2026-04-29T12:00:00.000Z",
    writer: (line) => lines.push(line)
  });

  logger.info("runner.started", {
    authorization: "Bearer live-token",
    nested: {
      apiKey: "api-key-value",
      webhook_signature: "sig-value",
      note: "sent Bearer nested-token to runner"
    },
    route_fingerprint: "sha256:route",
    proof_digest: "sha256:proof"
  });

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);

  assert.equal(record.timestamp, "2026-04-29T12:00:00.000Z");
  assert.equal(record.level, "info");
  assert.equal(record.event, "runner.started");
  assert.equal(record.instance_id, "instance-a");
  assert.equal(record.run_id, "run_1");
  assert.equal(record.attempt_id, "attempt_1");
  assert.equal(record.card_id, "card_1");
  assert.equal(record.card_number, 42);
  assert.equal(record.route_id, "route_1");
  assert.equal(record.route_fingerprint, "sha256:route");
  assert.equal(record.workspace_key, "app");
  assert.equal(record.workspace_path, "/tmp/workspace");
  assert.equal(record.runner_kind, "cli_app_server");
  assert.equal(record.authorization, "[REDACTED]");
  assert.equal(record.nested.apiKey, "[REDACTED]");
  assert.equal(record.nested.webhook_signature, "[REDACTED]");
  assert.equal(record.nested.note, "sent Bearer [REDACTED] to runner");
  assert.equal(record.proof_digest, "sha256:proof");
});
