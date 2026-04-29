import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRunRegistry } from "../src/run-registry.js";

function attempt(overrides = {}) {
  return {
    run_id: "run_1",
    attempt_id: "attempt_1",
    card_id: "card_1",
    card_number: 1,
    board_id: "board_1",
    route_id: "route_1",
    route_fingerprint: "sha256:route",
    card_digest: "sha256:card",
    workspace_identity_digest: "sha256:workspace",
    workspace_path: "/tmp/workspace_1",
    workspace_key: "workspace_1",
    claim_id: "claim_1",
    runner_kind: "cli_app_server",
    status: "running",
    cleanup_state: "cleanup_planned",
    created_at: "2026-04-29T12:00:00.000Z",
    updated_at: "2026-04-29T12:00:00.000Z",
    ...overrides
  };
}

test("run registry writes one durable JSON record per attempt under observability state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-runs-"));
  const registry = createRunRegistry({ stateDir: join(dir, "state") });

  const written = await registry.writeAttempt(attempt());
  const attempts = await registry.readAttempts();
  const onDisk = JSON.parse(await readFile(written.path, "utf8"));

  assert.equal(written.path, join(dir, "state", "runs", "attempt_1.json"));
  assert.equal(onDisk.schema_version, "fizzy-symphony-run-attempt-v1");
  assert.equal(onDisk.run_id, "run_1");
  assert.equal(onDisk.attempt_id, "attempt_1");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "running");
  assert.equal(attempts[0].workspace_path, "/tmp/workspace_1");
});

test("run registry updates attempts durably and sorts reads by creation time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-run-update-"));
  const registry = createRunRegistry({ stateDir: join(dir, "state") });

  await registry.writeAttempt(attempt({
    run_id: "run_2",
    attempt_id: "attempt_2",
    created_at: "2026-04-29T12:05:00.000Z"
  }));
  await registry.writeAttempt(attempt());

  const updated = await registry.updateAttempt("attempt_1", {
    status: "interrupted",
    workspace_preserved: true,
    preservation_reason: "interrupted during previous daemon run",
    interrupted_at: "2026-04-29T12:10:00.000Z"
  });
  const attempts = await registry.readAttempts();

  assert.equal(updated.status, "interrupted");
  assert.equal(updated.workspace_preserved, true);
  assert.deepEqual(attempts.map((entry) => entry.attempt_id), ["attempt_1", "attempt_2"]);
  assert.equal(attempts[0].interrupted_at, "2026-04-29T12:10:00.000Z");
});
