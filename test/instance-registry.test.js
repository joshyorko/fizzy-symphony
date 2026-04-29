import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import {
  inspectInstanceRegistry,
  instanceRegistryPath,
  shapeInstanceRecord,
  startHeartbeat,
  writeInstanceRecord
} from "../src/instance-registry.js";

function registryFile(overrides = {}) {
  return {
    instance_id: "instance-old",
    config_path: "/tmp/fizzy/config.yml",
    pid: 111,
    host: "host-a",
    port: 4567,
    base_url: "http://127.0.0.1:4567",
    watched_boards: ["board_1"],
    workspace_root: "/tmp/workspaces",
    started_at: "2026-04-29T11:00:00.000Z",
    heartbeat_at: "2026-04-29T11:00:00.000Z",
    ...overrides
  };
}

async function writeRegistryFile(dir, name, entry) {
  const path = join(dir, name);
  await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  return path;
}

test("instance registry removes only confirmed stale files and blocks same-instance live ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-instances-"));
  await writeRegistryFile(dir, "stale.json", registryFile({
    instance_id: "instance-stale",
    pid: 111,
    heartbeat_at: "2026-04-29T11:55:00.000Z"
  }));
  await writeRegistryFile(dir, "same-live.json", registryFile({
    instance_id: "instance-a",
    pid: 222,
    heartbeat_at: "2026-04-29T12:00:00.000Z"
  }));
  await writeRegistryFile(dir, "other-live.json", registryFile({
    instance_id: "instance-b",
    pid: 333,
    heartbeat_at: "2026-04-29T12:00:00.000Z"
  }));
  await writeRegistryFile(dir, "uncertain.json", registryFile({
    instance_id: "instance-uncertain",
    pid: 444,
    heartbeat_at: "2026-04-29T11:55:00.000Z"
  }));

  const report = await inspectInstanceRegistry({
    registryDir: dir,
    currentInstanceId: "instance-a",
    configPath: "/tmp/fizzy/config.yml",
    hostname: "host-a",
    now: "2026-04-29T12:00:00.000Z",
    staleHeartbeatMs: 60000,
    isProcessLive({ pid }) {
      return new Map([
        [111, false],
        [222, true],
        [333, true],
        [444, null]
      ]).get(pid);
    }
  });
  const remaining = await readdir(dir);

  assert.deepEqual(report.removed_stale_instances.map((entry) => entry.instance_id), ["instance-stale"]);
  assert.deepEqual(report.live_instances.map((entry) => entry.instance_id).sort(), ["instance-a", "instance-b"]);
  assert.deepEqual(report.stale_unconfirmed_instances.map((entry) => entry.instance_id), ["instance-uncertain"]);
  assert.equal(report.errors[0].code, "INSTANCE_REGISTRY_LIVE_SAME_INSTANCE");
  assert.equal(report.warnings[0].code, "INSTANCE_REGISTRY_STALE_UNCONFIRMED");
  assert.ok(report.warnings.some((warning) => warning.code === "INSTANCE_REGISTRY_LIVE_OTHER_INSTANCE"));
  assert.deepEqual(remaining.sort(), ["other-live.json", "same-live.json", "uncertain.json"]);
  await assert.rejects(readFile(join(dir, "stale.json"), "utf8"), { code: "ENOENT" });
});

test("instance registry writes required fields with atomic temp-file rename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-instance-record-"));
  const config = {
    boards: {
      entries: [
        { id: "board_b", enabled: true },
        { id: "board_a", enabled: true },
        { id: "board_disabled", enabled: false }
      ]
    },
    server: { registry_dir: join(dir, "instances") },
    workspaces: { root: join(dir, "workspaces") }
  };
  const record = shapeInstanceRecord({
    identity: { id: "instance-a", label: "local" },
    config,
    configPath: join(dir, "config.json"),
    endpoint: { host: "127.0.0.1", port: 4567, base_url: "http://127.0.0.1:4567" },
    hostname: "host-a",
    pid: 123,
    now: "2026-04-29T12:00:00.000Z"
  });

  const written = await writeInstanceRecord(record, { registryDir: config.server.registry_dir });
  const files = await readdir(config.server.registry_dir);
  const onDisk = JSON.parse(await readFile(written.path, "utf8"));

  assert.deepEqual(files, ["instance-a.json"]);
  assert.equal(onDisk.schema_version, "fizzy-symphony-instance-v1");
  assert.equal(onDisk.instance_id, "instance-a");
  assert.equal(onDisk.config_path, join(dir, "config.json"));
  assert.equal(onDisk.pid, 123);
  assert.equal(onDisk.hostname, "host-a");
  assert.equal(onDisk.host, "127.0.0.1");
  assert.equal(onDisk.port, 4567);
  assert.equal(onDisk.base_url, "http://127.0.0.1:4567");
  assert.deepEqual(onDisk.watched_boards, ["board_a", "board_b"]);
  assert.equal(onDisk.workspace_root, join(dir, "workspaces"));
  assert.equal(onDisk.started_at, "2026-04-29T12:00:00.000Z");
  assert.equal(onDisk.heartbeat_at, "2026-04-29T12:00:00.000Z");
});

test("instance registry heartbeat updates the live file and stops during cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-instance-heartbeat-"));
  const registryDir = join(dir, "instances");
  const record = registryFile({
    instance_id: "instance-heartbeat",
    config_path: join(dir, "config.json"),
    pid: process.pid,
    hostname: "host-a",
    heartbeat_at: "2026-04-29T12:00:00.000Z"
  });
  await writeInstanceRecord(record, { registryDir });

  const heartbeat = startHeartbeat(record, { registryDir, intervalMs: 20 });
  try {
    await sleep(70);
    const updated = JSON.parse(await readFile(instanceRegistryPath(registryDir, "instance-heartbeat"), "utf8"));
    assert.notEqual(updated.heartbeat_at, "2026-04-29T12:00:00.000Z");

    heartbeat.stop();
    await heartbeat.flush();
    const stoppedAt = JSON.parse(await readFile(instanceRegistryPath(registryDir, "instance-heartbeat"), "utf8")).heartbeat_at;
    await sleep(50);
    const afterStop = JSON.parse(await readFile(instanceRegistryPath(registryDir, "instance-heartbeat"), "utf8"));
    assert.equal(afterStop.heartbeat_at, stoppedAt);
  } finally {
    heartbeat.stop();
  }
});
