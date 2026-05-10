import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { discoverStatusEndpoints } from "./status-discovery.js";
import { createTerminalRenderer, supportsColor } from "./terminal-renderer.js";

const DEFAULT_REGISTRY_DIR = ".fizzy-symphony/run/instances";
const DEFAULT_ENDPOINT = "http://127.0.0.1:4567";

export async function runStatusCommand(args = [], io = defaultIo(), deps = {}) {
  const options = parseArgs(args);
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  if (options.configPath && !options.endpoint) {
    const config = await loadConfig(options.configPath, { env: io.env ?? process.env });
    const discovery = await discoverStatusEndpoints(config, {
      instanceId: options.instanceId,
      now: deps.now ?? new Date(),
      hostname: deps.hostname,
      isPidAlive: deps.isPidAlive
    });
    io.stdout.write(`${JSON.stringify({ ok: true, ...discovery })}\n`);
    return 0;
  }

  if (!fetchImpl) {
    io.stderr.write("No fetch implementation is available for status discovery.\n");
    return 3;
  }

  const endpoints = unique([
    ...explicitEndpoints(options),
    ...(await discoverRegistryEndpoints(options.registryDir)),
    ...(options.defaultEndpoint ? [defaultEndpoint(options)] : [])
  ]);

  for (const endpoint of endpoints) {
    const url = statusUrl(endpoint);
    try {
      const response = await fetchImpl(url);
      if (!response?.ok) {
        throw new Error(`status endpoint returned ${response?.status ?? "unknown"}`);
      }
      const snapshot = await response.json();
      io.stdout.write(renderStatus(snapshot, {
        endpoint,
        color: supportsColor(io.env ?? process.env, io.stdout)
      }) + "\n");
      return 0;
    } catch {
      continue;
    }
  }

  io.stderr.write("No live fizzy-symphony instance found. Start the daemon or pass --endpoint/--registry-dir.\n");
  return 3;
}

export async function discoverRegistryEndpoints(registryDir = DEFAULT_REGISTRY_DIR) {
  let entries;
  try {
    entries = await readdir(registryDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const discovered = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(join(registryDir, entry.name), "utf8"));
      const endpoint = endpointFromRecord(record);
      if (endpoint) {
        discovered.push({ endpoint, updated_at: record.updated_at ?? record.last_seen_at ?? "" });
      }
    } catch {
      continue;
    }
  }

  return discovered
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
    .map((record) => record.endpoint);
}

export function renderStatus(snapshot = {}, source = {}) {
  const renderer = createTerminalRenderer(source);
  const readiness = snapshot.readiness ?? {};
  const runnerHealth = snapshot.runner_health ?? {};
  const validation = snapshot.validation ?? {};
  const tokenRateLimit = snapshot.token_rate_limit ?? {};
  const instance = snapshot.instance ?? {};
  const endpoint = snapshot.endpoint?.base_url ?? source.endpoint ?? "unknown";
  const ready = readiness.ready === true;

  return [
    renderer.title("Fizzy Symphony Status", "Live daemon snapshot for the board-native workflow"),
    `${renderer.badge(ready ? "success" : "warning", ready ? "ready" : "not ready")} ${instance.id ?? "unknown"}${instance.label ? ` (${instance.label})` : ""}`,
    "",
    renderer.section("Overview"),
    renderer.kvRows([
      ["Instance", `${instance.id ?? "unknown"}${instance.label ? ` (${instance.label})` : ""}`],
      ["Endpoint", endpoint],
      ["Readiness", renderer.badge(ready ? "success" : "warning", ready ? "ready" : "not ready")],
      ["Runner", `${runnerHealth.kind ?? "unknown"} ${runnerHealth.status ?? "unknown"}`],
      ["Token/rate metadata", tokenRateLimit.available ? "available" : "unavailable"]
    ]),
    "",
    renderer.section("Work queues"),
    renderer.kvRows([
      ["Boards", (snapshot.watched_boards ?? []).length],
      ["Active runs", (snapshot.active_runs ?? []).length],
      ["Claims", (snapshot.claims ?? []).length],
      ["Workpads", (snapshot.workpads ?? []).length],
      ["Retry queue", (snapshot.retry_queue ?? []).length]
    ]),
    "",
    renderer.section("Recent activity"),
    renderer.kvRows([
      ["Recent completions", (snapshot.recent_completions ?? []).length],
      ["Recent failures", (snapshot.recent_failures ?? []).length]
    ]),
    "",
    renderer.section("Validation"),
    renderer.kvRows([
      ["Validation warnings", (validation.warnings ?? []).length],
      ["Validation errors", (validation.errors ?? []).length]
    ])
  ].join("\n");
}

function parseArgs(args) {
  return {
    endpoint: optionValue(args, "--endpoint"),
    configPath: optionValue(args, "--config"),
    instanceId: optionValue(args, "--instance"),
    registryDir: optionValue(args, "--registry-dir") ?? DEFAULT_REGISTRY_DIR,
    host: optionValue(args, "--host") ?? "127.0.0.1",
    port: optionValue(args, "--port") ?? "4567",
    defaultEndpoint: !args.includes("--no-default-endpoint")
  };
}

function explicitEndpoints(options) {
  return options.endpoint ? [options.endpoint] : [];
}

function defaultEndpoint(options) {
  if (options.host === "127.0.0.1" && options.port === "4567") return DEFAULT_ENDPOINT;
  return `http://${options.host}:${options.port}`;
}

function endpointFromRecord(record) {
  if (record.endpoint?.base_url) return record.endpoint.base_url;
  if (record.base_url) return record.base_url;
  if (record.endpoint?.host && record.endpoint?.port) {
    return `http://${record.endpoint.host}:${record.endpoint.port}`;
  }
  if (record.host && record.port) return `http://${record.host}:${record.port}`;
  return null;
}

function statusUrl(endpoint) {
  return `${String(endpoint).replace(/\/+$/u, "")}/status`;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function defaultIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env
  };
}
