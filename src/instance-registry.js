import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join, resolve } from "node:path";

import { bindServerListener } from "./listener.js";
import { FizzySymphonyError } from "./errors.js";
import { resolveInstanceIdentity } from "./instance.js";

const INSTANCE_SCHEMA_VERSION = "fizzy-symphony-instance-v1";
const DEFAULT_REGISTRY_DIR = ".fizzy-symphony/run/instances";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;

export function instanceRegistryPath(registryDir, instanceId) {
  return join(registryDir, `${safeFilePart(instanceId)}.json`);
}

export function shapeInstanceRecord(options = {}) {
  const {
    identity = {},
    config = {},
    configPath,
    endpoint = {},
    hostname = osHostname(),
    pid = process.pid,
    now = new Date()
  } = options;
  const timestamp = toIso(now);

  return omitUndefined({
    schema_version: INSTANCE_SCHEMA_VERSION,
    instance_id: identity.id ?? config.instance?.id,
    label: identity.label ?? config.instance?.label,
    config_path: configPath,
    pid,
    hostname,
    host: endpoint.host ?? config.server?.host ?? "127.0.0.1",
    port: endpoint.port ?? config.server?.port,
    base_url: endpoint.base_url ?? endpoint.baseUrl,
    watched_boards: watchedBoardIds(config),
    workspace_root: config.workspaces?.root,
    started_at: timestamp,
    heartbeat_at: timestamp
  });
}

export async function writeInstanceRecord(record = {}, { registryDir } = {}) {
  const path = instanceRegistryPath(registryDir, record.instance_id);
  const body = `${JSON.stringify(record, null, 2)}\n`;

  await mkdir(registryDir, { recursive: true });
  const tmpPath = join(registryDir, `.${safeFilePart(record.instance_id)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmpPath, body, "utf8");
  await rename(tmpPath, path);

  return {
    path,
    bytes: Buffer.byteLength(body),
    record
  };
}

export function startHeartbeat(record = {}, { registryDir, intervalMs = 30000, now = () => new Date() } = {}) {
  let stopped = false;
  let pending = Promise.resolve();

  function writeHeartbeat() {
    if (stopped) return pending;
    pending = writeInstanceRecord({
      ...record,
      heartbeat_at: toIso(typeof now === "function" ? now() : now)
    }, { registryDir });
    return pending;
  }

  const timer = setInterval(() => {
    void writeHeartbeat();
  }, intervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    flush() {
      return pending;
    }
  };
}

export async function startLocalInstance(config = {}, options = {}) {
  const configPath = resolve(options.configPath ?? ".fizzy-symphony/config.json");
  const hostname = options.hostname ?? osHostname();
  const registryDir = resolve(config.server?.registry_dir ?? DEFAULT_REGISTRY_DIR);
  const heartbeatIntervalMs = config.server?.heartbeat_interval_ms ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const identity = resolveInstanceIdentity(config, { ...options, configPath, hostname });
  const registryReport = await inspectInstanceRegistry({
    registryDir,
    currentInstanceId: identity.id,
    configPath,
    hostname,
    now: options.now ?? new Date(),
    staleHeartbeatMs: options.staleHeartbeatMs ?? Math.max(3 * heartbeatIntervalMs, 30000),
    isProcessLive: options.isProcessLive ?? isRegistryProcessLive
  });

  if (registryReport.errors.length > 0) {
    throw new FizzySymphonyError(
      "INSTANCE_REGISTRY_CONFLICT",
      "A live fizzy-symphony instance already owns this instance ID.",
      registryReport
    );
  }

  const listener = await bindServerListener(config.server ?? {}, {
    requestListener: options.requestListener
  });
  const record = shapeInstanceRecord({
    identity,
    config,
    configPath,
    endpoint: listener.endpoint,
    hostname,
    pid: options.pid,
    now: options.now
  });
  try {
    const written = await writeInstanceRecord(record, { registryDir });
    const heartbeat = startHeartbeat(record, {
      registryDir,
      intervalMs: heartbeatIntervalMs,
      now: options.heartbeatNow ?? (() => new Date())
    });

    return {
      identity,
      endpoint: listener.endpoint,
      registryPath: written.path,
      registryReport,
      record: written.record,
      listener,
      heartbeat,
      async cleanup() {
        heartbeat.stop();
        await heartbeat.flush();
        await listener.close();
        await rm(written.path, { force: true });
      }
    };
  } catch (error) {
    await listener.close();
    throw error;
  }
}

export async function inspectInstanceRegistry(options = {}) {
  const {
    registryDir,
    currentInstanceId,
    configPath,
    hostname = osHostname(),
    now = new Date(),
    staleHeartbeatMs = 15000,
    isProcessLive = () => null
  } = options;

  const report = {
    removed_stale_instances: [],
    live_instances: [],
    warnings: [],
    errors: []
  };
  const liveConflictWarnings = [];

  const records = await readRegistryRecords(registryDir);
  for (const { path, record } of records) {
    const liveState = isProcessLive(record);
    const stale = isHeartbeatStale(record, now, staleHeartbeatMs);
    const confirmedScope = isSameHost(record, hostname) && isSameConfigPath(record, configPath);

    if (stale && liveState === false && confirmedScope) {
      await rm(path, { force: true });
      report.removed_stale_instances.push({ ...record, path });
      continue;
    }

    if (stale && liveState !== false) {
      report.warnings.push({
        code: "INSTANCE_REGISTRY_STALE_UNCONFIRMED",
        message: "Instance registry entry is stale but process ownership could not be disproved.",
        instance_id: record.instance_id,
        path
      });
      continue;
    }

    report.live_instances.push({ ...record, path });
    if (record.instance_id === currentInstanceId && liveState !== false) {
      report.errors.push({
        code: "INSTANCE_REGISTRY_LIVE_SAME_INSTANCE",
        message: "A live registry entry already exists for this instance ID.",
        instance_id: record.instance_id,
        path
      });
    } else if (currentInstanceId && liveState !== false) {
      liveConflictWarnings.push({
        code: "INSTANCE_REGISTRY_LIVE_OTHER_INSTANCE",
        message: "Another live fizzy-symphony instance is registered locally.",
        instance_id: record.instance_id,
        path
      });
    }
  }

  report.warnings.push(...liveConflictWarnings);
  return report;
}

export async function readRegistryRecords(registryDir) {
  let entries;
  try {
    entries = await readdir(registryDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(registryDir, entry.name);
    try {
      records.push({ path, record: JSON.parse(await readFile(path, "utf8")) });
    } catch {
      continue;
    }
  }

  return records;
}

function isHeartbeatStale(record, now, staleHeartbeatMs) {
  const heartbeat = Date.parse(record.heartbeat_at ?? record.updated_at ?? record.started_at ?? 0);
  if (!Number.isFinite(heartbeat)) return true;
  return Date.parse(toIso(now)) - heartbeat > staleHeartbeatMs;
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function safeFilePart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/gu, "_");
}

function isRegistryProcessLive(record, { hostname = osHostname() } = {}) {
  if (!isSameHost(record, hostname)) return null;
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return null;
  }
}

function isSameHost(record, hostname) {
  return !record.hostname || !hostname || record.hostname === hostname;
}

function isSameConfigPath(record, configPath) {
  return !record.config_path || !configPath || resolve(record.config_path) === resolve(configPath);
}

function watchedBoardIds(config) {
  return (config.boards?.entries ?? [])
    .filter((entry) => entry.enabled !== false)
    .map((entry) => entry.id)
    .sort();
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
