#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCliFizzyClient, createCliRunner, resolveFizzyClientConfig } from "../src/client-factories.js";
import { loadConfig, writeAnnotatedConfig } from "../src/config.js";
import { startDaemon } from "../src/daemon.js";
import { isFizzySymphonyError } from "../src/errors.js";
import { runSetup } from "../src/setup.js";
import { runStatusCommand } from "../src/status-cli.js";
import { discoverStatusEndpoints } from "../src/status-discovery.js";
import { validateStartup } from "../src/validation.js";

export async function main(args = process.argv.slice(2), io = defaultIo()) {
  const command = args[0];

  try {
    if (isHelpCommand(args)) {
      return usage(0, io);
    } else if (command === "init") {
      return await initCommand(args.slice(1), io);
    } else if (command === "setup") {
      return await setupCommand(args.slice(1), io);
    } else if (command === "validate") {
      return await validateCommand(args.slice(1), io);
    } else if (command === "daemon" || command === "start") {
      await daemonCommand(args.slice(1), io, { commandName: command });
    } else if (command === "status") {
      if (args.includes("--config")) {
        await statusDiscoveryCommand(args.slice(1), io);
        return 0;
      }
      return runStatusCommand(args.slice(1), io);
    } else {
      return usage(command ? 1 : 0, io);
    }
    return 0;
  } catch (error) {
    const payload = {
      ok: false,
      code: error.code ?? "CLI_ERROR",
      message: error.message,
      details: error.details ?? {}
    };
    io.stderr.write(`${JSON.stringify(payload)}\n`);
    return isFizzySymphonyError(error) ? 2 : 1;
  }
}

async function statusDiscoveryCommand(args, io) {
  const configPath = optionValue(args, "--config") ?? ".fizzy-symphony/config.yml";
  const instanceId = optionValue(args, "--instance");
  const env = await envWithCliOverrides(io.env ?? process.env, args, {
    dotenvBasePath: envBaseForConfig(configPath)
  });
  const config = await loadConfig(configPath, { env });
  const discovery = await discoverStatusEndpoints(config, {
    instanceId,
    now: typeof io.now === "function" ? io.now() : new Date(),
    hostname: io.hostname,
    isPidAlive: io.isPidAlive
  });

  io.stdout.write(`${JSON.stringify({ ok: true, ...discovery })}\n`);
}

async function setupCommand(args, io) {
  return setupCommandWithOptions(args, io);
}

async function initCommand(args, io) {
  return setupCommandWithOptions(args, io, {
    defaultSetupMode: "create_starter",
    createStarterWorkflow: true,
    friendlyOutput: true
  });
}

async function setupCommandWithOptions(args, io, commandOptions = {}) {
  const configPath = optionValue(args, "--config") ?? ".fizzy-symphony/config.yml";
  if (args.includes("--template-only")) {
    await writeAnnotatedConfig(configPath, { runnerPreferred: "cli_app_server" });
    io.stdout.write(`wrote annotated config: ${configPath}\n`);
    return 0;
  }

  const env = await envWithCliOverrides(io.env ?? process.env, args, {
    dotenvBasePath: optionValue(args, "--workspace-repo") ?? "."
  });
  const dependencyConfig = resolveFizzyClientConfig({
    config: { runner: { preferred: "cli_app_server" } },
    env
  });
  const fizzy = await createFizzyDependency({ io, config: dependencyConfig, env });
  const runner = await createRunnerDependency({ io, config: dependencyConfig, env });

  const result = await runSetup({
    configPath,
    fizzy,
    runner,
    prompts: io.prompts,
    env,
    apiUrl: dependencyConfig.fizzy.api_url,
    account: optionValue(args, "--account") ?? undefined,
    selectedBoardIds: boardValues(args),
    setupMode: setupModeForArgs(args, commandOptions.defaultSetupMode),
    workspaceRepo: optionValue(args, "--workspace-repo") ?? ".",
    starterBoardName: optionValue(args, "--starter-board-name") ?? undefined,
    createStarterWorkflow: commandOptions.createStarterWorkflow ||
      args.includes("--starter") ||
      args.includes("--new-board") ||
      args.includes("--create-starter-workflow") ||
      args.includes("--starter-workflow"),
    createSmokeTestCard: args.includes("--smoke-card"),
    botUserId: optionValue(args, "--bot-user-id") ?? undefined,
    webhook: webhookOptions(args)
  });

  if (commandOptions.friendlyOutput) {
    io.stdout.write(formatInitSuccess(result));
    return 0;
  }

  io.stdout.write(`${JSON.stringify({
    ok: true,
    path: result.path,
    account: result.account,
    boards: result.boards.map((board) => board.id),
    runner: result.runner.kind,
    warnings: result.warnings.map((warning) => warning.code)
  })}\n`);
  return 0;
}

async function validateCommand(args, io) {
  const configPath = optionValue(args, "--config") ?? ".fizzy-symphony/config.yml";
  const env = await envWithCliOverrides(io.env ?? process.env, args, {
    dotenvBasePath: envBaseForConfig(configPath)
  });
  const config = await loadConfig(configPath, { env });
  if (args.includes("--parse-only")) {
    io.stdout.write(`${JSON.stringify({ ok: true, mode: "parse-only" })}\n`);
    return 0;
  }

  const fizzy = await createFizzyDependency({ io, config, env });
  const runner = await createRunnerDependency({ io, config, env });
  const report = await validateStartup({ config, fizzy, runner });
  io.stdout.write(`${JSON.stringify({
    ok: report.ok,
    mode: "startup",
    errors: report.errors,
    warnings: report.warnings,
    routes: report.routes,
    resolvedTags: report.resolvedTags,
    runnerHealth: report.runnerHealth
  })}\n`);
  return report.ok ? 0 : 2;
}

async function createFizzyDependency({ io, config, env }) {
  if (io.fizzy) return io.fizzy;
  const factory = io.clientFactories?.createFizzyClient ?? ((options) => createCliFizzyClient({
    ...options,
    fetch: io.fetch,
    transport: io.fizzyTransport,
    normalize: io.fizzyNormalize,
    etagCache: io.fizzyEtagCache
  }));
  return factory({ config, env });
}

async function createRunnerDependency({ io, config, env }) {
  if (io.runner) return io.runner;
  const factory = io.clientFactories?.createRunner ?? ((options) => createCliRunner({
    ...options,
    runnerOptions: io.runnerOptions
  }));
  return factory({ config, env });
}

async function daemonCommand(args, io, options = {}) {
  const configPath = optionValue(args, "--config") ?? ".fizzy-symphony/config.yml";
  const env = await envWithCliOverrides(io.env ?? process.env, args, {
    dotenvBasePath: envBaseForConfig(configPath)
  });
  const daemon = await startDaemon({
    configPath,
    env,
    signalProcess: io.signalProcess ?? process,
    ...(io.daemonOptions ?? {})
  });

  io.stdout.write(`${JSON.stringify({
    ok: true,
    command: options.commandName ?? "daemon",
    status: "running",
    instance_id: daemon.status.status().instance.id,
    endpoint: daemon.endpoint
  })}\n`);

  await io.daemonStarted?.(daemon);
  await daemon.stopped;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function boardValues(args) {
  const repeated = optionValues(args, "--board");
  const commaSeparated = optionValue(args, "--boards");
  const values = [
    ...repeated,
    ...(commaSeparated ? commaSeparated.split(",") : [])
  ].map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function setupModeForArgs(args, defaultMode) {
  if (args.includes("--starter") || args.includes("--new-board")) return "create_starter";
  if (args.includes("--adopt-starter")) return "adopt_starter";
  return normalizeSetupMode(optionValue(args, "--mode") ?? defaultMode);
}

function normalizeSetupMode(mode) {
  if (!mode) return undefined;
  const normalized = mode.trim().replaceAll("-", "_");
  if (normalized === "starter" || normalized === "new_board") return "create_starter";
  return normalized;
}

async function envWithCliOverrides(env, args, options = {}) {
  const envFile = optionValue(args, "--env-file");
  const fileEnv = envFile === "none"
    ? {}
    : await readDotEnv(envFile ?? join(options.dotenvBasePath ?? ".", ".env"));
  const overridden = { ...fileEnv, ...env };
  if (!overridden.FIZZY_API_TOKEN) {
    overridden.FIZZY_API_TOKEN = firstNonEmpty(overridden.FIZZY_TOKEN, overridden.FIZYY_TOKEN) ?? overridden.FIZZY_API_TOKEN;
  }
  const apiUrl = optionValue(args, "--api-url");
  const token = optionValue(args, "--token");
  if (apiUrl) overridden.FIZZY_API_URL = apiUrl;
  if (token) overridden.FIZZY_API_TOKEN = token;
  return overridden;
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

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null);
}

function formatInitSuccess(result) {
  const board = result.boards[0];
  const boardName = board?.name ?? board?.label ?? board?.id ?? "selected board";
  const boardId = board?.id ?? "unknown";
  return [
    "fizzy-symphony is ready.",
    "",
    `Config: ${result.path}`,
    `Board: ${boardName} (${boardId})`,
    "Route: Ready for Agents -> Done",
    `Runner: ${result.runner.kind}`,
    "",
    "Start:",
    `  node bin/fizzy-symphony.js start --config ${result.path}`,
    "",
    "Use it:",
    "  Create a normal Fizzy card in Ready for Agents.",
    "  The golden card is already the route; do not edit it for the smoke test.",
    ""
  ].join("\n");
}

function webhookOptions(args) {
  const manage = args.includes("--manage-webhooks");
  const callbackUrl = optionValue(args, "--webhook-callback-url");
  const actions = optionValue(args, "--webhook-actions");

  if (!manage && !callbackUrl && !actions) return {};

  return {
    manage,
    callback_url: callbackUrl ?? "",
    subscribed_actions: actions?.split(",").map((action) => action.trim()).filter(Boolean)
  };
}

function isHelpCommand(args) {
  return args.length === 1 && (args[0] === "--help" || args[0] === "-h");
}

function usage(exitCode, io) {
  const text = [
    "Usage:",
    "  fizzy-symphony init [--api-url url] [--token token] [--env-file path] [--workspace-repo path]",
    "  fizzy-symphony setup --template-only [--config path]",
    "  fizzy-symphony setup [--starter] [--config path] [--account id] [--board id] [--boards id,id] [--workspace-repo path]",
    "  fizzy-symphony validate [--parse-only] [--config path]",
    "  fizzy-symphony start [--config path]",
    "  fizzy-symphony daemon [--config path]",
    "  fizzy-symphony status [--config path] [--instance id]",
    "  fizzy-symphony status [--registry-dir path] [--endpoint url]"
  ].join("\n");
  io.stdout.write(`${text}\n`);
  return exitCode;
}

function defaultIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
