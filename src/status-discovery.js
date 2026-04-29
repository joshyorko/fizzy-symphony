import { readRegistryRecords } from "./instance-registry.js";

export async function discoverStatusEndpoints(config = {}, options = {}) {
  const registryDir = config.server?.registry_dir;
  const heartbeatIntervalMs = config.server?.heartbeat_interval_ms ?? 5000;
  const staleHeartbeatMs = Math.max(3 * heartbeatIntervalMs, 30000);
  const records = registryDir ? await readRegistryRecords(registryDir) : [];
  const instances = [];

  for (const { record } of records) {
    if (options.instanceId && record.instance_id !== options.instanceId) continue;
    if (!isLive(record, { ...options, staleHeartbeatMs })) continue;
    instances.push(normalizeEndpoint(record, "registry"));
  }

  if (instances.length > 0) {
    return {
      fallback_used: false,
      instances: instances.sort((left, right) => String(left.instance_id).localeCompare(String(right.instance_id)))
    };
  }

  return {
    fallback_used: true,
    instances: [fallbackEndpoint(config)]
  };
}

function isLive(record, options) {
  const processLive = options.isPidAlive ? options.isPidAlive(record) : true;
  if (processLive === false) return false;
  if (processLive === true) return true;
  const heartbeat = Date.parse(record.heartbeat_at ?? record.updated_at ?? record.started_at ?? 0);
  if (!Number.isFinite(heartbeat)) return false;
  return Date.parse(toIso(options.now ?? new Date())) - heartbeat <= options.staleHeartbeatMs;
}

function normalizeEndpoint(record, source) {
  return {
    instance_id: record.instance_id ?? null,
    host: record.host ?? record.endpoint?.host ?? "127.0.0.1",
    port: record.port ?? record.endpoint?.port,
    base_url: record.base_url ?? record.endpoint?.base_url ?? `http://${record.host ?? "127.0.0.1"}:${record.port}`,
    source
  };
}

function fallbackEndpoint(config) {
  const host = config.server?.host ?? "127.0.0.1";
  const port = Number.isInteger(config.server?.port) ? config.server.port : config.server?.base_port ?? 4567;
  return {
    instance_id: null,
    host,
    port,
    base_url: `http://${host}:${port}`,
    source: "fallback"
  };
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
