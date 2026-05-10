import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { discoverRegistryEndpoints } from "./status-cli.js";
import { createDashboardModel, renderDashboardText } from "./dashboard-model.js";
import { loadConfig } from "./config.js";
import { discoverStatusEndpoints } from "./status-discovery.js";

const DEFAULT_REGISTRY_DIR = ".fizzy-symphony/run/instances";
const DEFAULT_ENDPOINT = "http://127.0.0.1:4567";

export async function runDashboardCommand(args = [], io = defaultIo(), deps = {}) {
  const options = parseArgs(args);
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  if (!fetchImpl) {
    io.stderr.write("No fetch implementation is available for dashboard status.\n");
    return 3;
  }

  const endpoints = unique([
    ...(options.endpoint ? [options.endpoint] : []),
    ...(await discoverConfigEndpoints(options, io, deps)),
    ...(await discoverRegistryEndpoints(options.registryDir)),
    ...(options.defaultEndpoint ? [DEFAULT_ENDPOINT] : [])
  ]);

  for (const endpoint of endpoints) {
    let snapshot;
    try {
      snapshot = await fetchStatus(fetchImpl, endpoint);
    } catch {
      continue;
    }

    if (isInteractive(io, options)) {
      return runInteractiveDashboard(fetchImpl, endpoint, snapshot, options, io, deps);
    }

    const model = createDashboardModel(snapshot, { endpoint });
    io.stdout.write(`${renderDashboardText(model)}\n`);
    return 0;
  }

  io.stderr.write("No live fizzy-symphony instance found. Start the daemon or pass --endpoint/--registry-dir.\n");
  return 3;
}

async function fetchStatus(fetchImpl, endpoint) {
  const response = await fetchImpl(`${String(endpoint).replace(/\/+$/u, "")}/status`);
  if (!response?.ok) throw new Error(`status endpoint returned ${response?.status ?? "unknown"}`);
  return response.json();
}

async function runInteractiveDashboard(fetchImpl, endpoint, initialSnapshot, options, io, deps) {
  let snapshot = initialSnapshot;
  let model = createDashboardModel(snapshot, { endpoint });
  let dashboard;
  try {
    dashboard = await (deps.createTerminalDashboard ?? createTerminalKitDashboard)(io, options);
    while (true) {
      model = createDashboardModel(snapshot, { endpoint });
      await dashboard.render(model, { refreshMs: options.refreshMs });
      const action = await dashboard.waitForInput(options.refreshMs);
      if (action === "exit") return 0;
      try {
        snapshot = await fetchStatus(fetchImpl, endpoint);
      } catch (error) {
        io.stderr.write(`Dashboard refresh failed: ${errorMessage(error)}\n`);
        return 3;
      }
    }
  } catch (error) {
    io.stderr.write(`Dashboard TUI unavailable: ${errorMessage(error)}\n`);
    io.stdout.write(`${renderDashboardText(model)}\n`);
    return 0;
  } finally {
    dashboard?.close?.();
  }
}

async function createTerminalKitDashboard() {
  const termkit = await import("terminal-kit");
  const terminal = termkit.default?.terminal ?? termkit.terminal;
  terminal.grabInput(true);

  return {
    render: (model, options) => renderTerminalKitDashboard(terminal, model, options),
    waitForInput: (refreshMs) => waitForTerminalInput(terminal, refreshMs),
    close: () => terminal.grabInput(false)
  };
}

function renderTerminalKitDashboard(terminal, model, options = {}) {
  terminal.clear();
  writeBold(terminal, `${model.title}\n`);
  terminal("Command: fizzy-symphony dashboard\n\n");
  terminal(`State: ${model.state.label} - ${model.state.detail}\n`);
  terminal(`Instance: ${model.instance.id}${model.instance.label ? ` (${model.instance.label})` : ""}\n`);
  terminal(`Endpoint: ${model.instance.endpoint}\n`);
  terminal(`Runner: ${model.runner.label}\n`);
  terminal(`Cleanup: ${model.cleanup.status}\n`);
  if (model.updatedAt) terminal(`Updated: ${model.updatedAt}\n`);
  terminal("\nCounters\n");
  writeTerminalMetrics(terminal, model.metrics);
  writeTerminalGroupedRows(terminal, "Board workflow", model.sections.boardWorkflow, "No watched boards or golden-ticket routes reported.");
  writeTerminalRows(terminal, "Active work", model.sections.activeWork, "No active work is running.");
  writeTerminalRows(terminal, "Recent activity", model.sections.recentActivity, "No recent completions or runtime warnings reported.");
  writeTerminalRows(terminal, "Failures and blockers", model.sections.failures, "No readiness blockers or recent failures reported.");
  terminal("\nFooter\n");
  terminal(`- Refresh: ${options.refreshMs}ms\n`);
  terminal("- Controls: q, Esc, or Ctrl-C exits the live dashboard.\n");
}

function writeTerminalMetrics(terminal, metrics = []) {
  const rows = metrics.filter((metric) => metric.value !== undefined);
  for (let index = 0; index < rows.length; index += 3) {
    terminal(`- ${rows.slice(index, index + 3).map((metric) => `${metric.label}: ${metric.value}`).join("  ")}\n`);
  }
}

function writeTerminalGroupedRows(terminal, title, groups = [], emptyText = "") {
  const visible = groups.filter(Boolean).slice(0, 4);
  terminal(`\n${title}:\n`);
  if (visible.length === 0) {
    if (emptyText) terminal(`- ${emptyText}\n`);
    return;
  }
  for (const group of visible) {
    terminal(`- ${group.title}\n`);
    for (const row of group.rows.slice(0, 3)) terminal(`  - ${row}\n`);
    if (group.rows.length > 3) terminal(`  - ... ${group.rows.length - 3} more\n`);
  }
  if (groups.length > visible.length) terminal(`- ... ${groups.length - visible.length} more\n`);
}

function writeTerminalRows(terminal, title, rows = [], emptyText = "") {
  const visible = rows.filter(Boolean).slice(0, 4);
  terminal(`\n${title}:\n`);
  if (visible.length === 0) {
    if (emptyText) terminal(`- ${emptyText}\n`);
    return;
  }
  for (const row of visible) terminal(`- ${row}\n`);
  if (rows.length > visible.length) terminal(`- ... ${rows.length - visible.length} more\n`);
}

function writeBold(terminal, text) {
  if (typeof terminal.bold === "function") {
    terminal.bold(text);
  } else {
    terminal(text);
  }
}

function waitForTerminalInput(terminal, refreshMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (action) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      removeTerminalListener(terminal, "key", onKey);
      resolve(action);
    };
    const onKey = (name) => {
      if (name === "q" || name === "CTRL_C" || name === "ESCAPE") finish("exit");
    };
    const timer = setTimeout(() => finish("refresh"), refreshMs);
    terminal.on("key", onKey);
  });
}

function removeTerminalListener(terminal, eventName, listener) {
  if (typeof terminal.off === "function") {
    terminal.off(eventName, listener);
  } else if (typeof terminal.removeListener === "function") {
    terminal.removeListener(eventName, listener);
  }
}

function isInteractive(io, options) {
  if (options.once) return false;
  if (io.env?.NO_COLOR || io.env?.CI || io.env?.TERM === "dumb") return false;
  return Boolean(io.stdout?.isTTY && io.stdin?.isTTY);
}

function parseArgs(args) {
  return {
    endpoint: optionValue(args, "--endpoint"),
    configPath: optionValue(args, "--config"),
    instanceId: optionValue(args, "--instance"),
    registryDir: optionValue(args, "--registry-dir") ?? DEFAULT_REGISTRY_DIR,
    dotenvPath: optionValue(args, "--dotenv") ?? optionValue(args, "--env-file"),
    refreshMs: positiveInteger(optionValue(args, "--refresh-ms"), 2000),
    once: args.includes("--once"),
    defaultEndpoint: !args.includes("--no-default-endpoint")
  };
}

async function discoverConfigEndpoints(options, io, deps) {
  if (!options.configPath || options.endpoint) return [];
  const env = await envWithConfigDotenv(options, io);
  const config = await loadConfig(options.configPath, { env });
  const discovery = await discoverStatusEndpoints(config, {
    instanceId: options.instanceId,
    now: typeof io.now === "function" ? io.now() : deps.now ?? new Date(),
    hostname: deps.hostname ?? io.hostname,
    isPidAlive: deps.isPidAlive ?? io.isPidAlive
  });
  return discovery.instances.map((instance) => instance.base_url);
}

async function envWithConfigDotenv(options, io) {
  const baseEnv = io.env ?? process.env;
  const fileEnv = options.dotenvPath === "none"
    ? {}
    : await readDotEnv(options.dotenvPath ?? join(envBaseForConfig(options.configPath), ".env"));
  const env = { ...fileEnv, ...baseEnv };
  if (!nonEmpty(env.FIZZY_API_TOKEN)) {
    env.FIZZY_API_TOKEN = firstNonEmpty(env.FIZZY_TOKEN, env.FIZYY_TOKEN) ?? env.FIZZY_API_TOKEN;
  }
  return env;
}

async function readDotEnv(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  return parseDotEnv(text);
}

function parseDotEnv(text) {
  const parsed = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    parsed[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return parsed;
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function envBaseForConfig(configPath) {
  const configDir = dirname(configPath);
  if (basename(configDir) === ".fizzy-symphony") return dirname(configDir);
  return configDir;
}

function positiveInteger(rawValue, fallback) {
  const parsed = Number(rawValue ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function firstNonEmpty(...values) {
  return values.find((value) => nonEmpty(value));
}

function nonEmpty(value) {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
    stdin: process.stdin,
    env: process.env
  };
}
