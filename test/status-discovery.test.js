import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { main as cliMain } from "../bin/fizzy-symphony.js";
import { discoverStatusEndpoints } from "../src/status-discovery.js";
import { instanceRegistryPath } from "../src/instance-registry.js";
import { coordinationConfig, tempProject } from "./helpers.js";

test("discoverStatusEndpoints reads multiple live registry entries unless an instance is selected", async () => {
  const root = await tempProject("fizzy-symphony-status-discovery-");
  const config = coordinationConfig(root, {
    server: { registry_dir: join(root, "instances"), heartbeat_interval_ms: 1000 }
  });
  await mkdir(config.server.registry_dir, { recursive: true });
  await writeRegistry(config.server.registry_dir, liveRecord(root, "instance-a", 49160));
  await writeRegistry(config.server.registry_dir, liveRecord(root, "instance-b", 49161));

  const all = await discoverStatusEndpoints(config, {
    now: "2026-04-29T12:00:05.000Z",
    hostname: "host-a",
    isPidAlive: () => true
  });
  const selected = await discoverStatusEndpoints(config, {
    instanceId: "instance-b",
    now: "2026-04-29T12:00:05.000Z",
    hostname: "host-a",
    isPidAlive: () => true
  });

  assert.equal(all.fallback_used, false);
  assert.deepEqual(all.instances.map((entry) => entry.instance_id), ["instance-a", "instance-b"]);
  assert.deepEqual(selected.instances.map((entry) => entry.instance_id), ["instance-b"]);
});

test("discoverStatusEndpoints falls back to default host and configured port when registry has no live entries", async () => {
  const root = await tempProject("fizzy-symphony-status-fallback-");
  const config = coordinationConfig(root, {
    server: {
      host: "127.0.0.1",
      port: "auto",
      base_port: 4567,
      registry_dir: join(root, "missing-instances")
    }
  });

  const discovery = await discoverStatusEndpoints(config, {
    now: "2026-04-29T12:00:05.000Z",
    hostname: "host-a",
    isPidAlive: () => false
  });

  assert.equal(discovery.fallback_used, true);
  assert.deepEqual(discovery.instances, [
    {
      instance_id: null,
      host: "127.0.0.1",
      port: 4567,
      base_url: "http://127.0.0.1:4567",
      source: "fallback"
    }
  ]);
});

test("CLI status discovers live instance registry entries and supports --instance selection", async () => {
  const root = await tempProject("fizzy-symphony-cli-status-");
  const config = coordinationConfig(root, {
    server: { registry_dir: join(root, "instances"), heartbeat_interval_ms: 1000 }
  });
  const configPath = join(root, "config.json");
  await mkdir(config.server.registry_dir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeRegistry(config.server.registry_dir, liveRecord(root, "instance-a", 49170));
  await writeRegistry(config.server.registry_dir, liveRecord(root, "instance-b", 49171));

  const io = captureIo();
  const exitCode = await cliMain(["status", "--config", configPath, "--instance", "instance-b"], io);
  const output = JSON.parse(io.stdout.output.trim());

  assert.equal(exitCode, 0);
  assert.equal(output.ok, true);
  assert.equal(output.fallback_used, false);
  assert.deepEqual(output.instances.map((entry) => entry.instance_id), ["instance-b"]);
});

function liveRecord(root, instanceId, port) {
  return {
    instance_id: instanceId,
    config_path: join(root, "config.json"),
    pid: process.pid,
    hostname: "host-a",
    host: "127.0.0.1",
    port,
    base_url: `http://127.0.0.1:${port}`,
    watched_boards: ["board_a"],
    workspace_root: join(root, ".fizzy-symphony", "workspaces"),
    started_at: "2026-04-29T12:00:00.000Z",
    heartbeat_at: "2026-04-29T12:00:04.000Z"
  };
}

async function writeRegistry(registryDir, record) {
  await writeFile(instanceRegistryPath(registryDir, record.instance_id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function captureIo() {
  return {
    stdout: captureStream(),
    stderr: captureStream(),
    now: () => new Date("2026-04-29T12:00:05.000Z"),
    env: {
      FIZZY_API_TOKEN: "test-token",
      FIZZY_WEBHOOK_SECRET: "test-secret"
    }
  };
}

function captureStream() {
  return {
    output: "",
    write(chunk) {
      this.output += chunk;
    }
  };
}
