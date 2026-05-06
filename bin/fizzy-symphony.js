#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_FIZZY_API_URL, createCliFizzyClient, createCliRunner, resolveFizzyClientConfig } from "../src/client-factories.js";
import { writeOpener } from "../src/cli-opener.js";
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
    if (usesFriendlyErrors(command, args.slice(1))) {
      io.stderr.write(formatFriendlyError(error, command));
      return isFizzySymphonyError(error) ? 2 : 1;
    }

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
  return setupCommandWithOptions(args, io, setupCommandOptionsForArgs(args));
}

async function initCommand(args, io) {
  return setupCommandWithOptions(args, io, {
    defaultSetupMode: "create_starter",
    createStarterWorkflow: true,
    friendlyOutput: true,
    promptForCredentials: true
  });
}

async function setupCommandWithOptions(args, io, commandOptions = {}) {
  const configPath = optionValue(args, "--config") ?? ".fizzy-symphony/config.yml";
  if (args.includes("--template-only")) {
    await writeAnnotatedConfig(configPath, { runnerPreferred: "cli_app_server" });
    io.stdout.write(`wrote annotated config: ${configPath}\n`);
    return 0;
  }

  const baseEnv = io.env ?? process.env;
  if (commandOptions.friendlyOutput) {
    await writeOpener(io, {
      env: baseEnv,
      frameDelayMs: io.openerFrameDelayMs
    });
  }

  const env = await envWithCliOverrides(baseEnv, args, {
    dotenvBasePath: optionValue(args, "--workspace-repo") ?? ".",
    promptForCredentials: commandOptions.promptForCredentials,
    prompts: promptProvider(io)
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

function setupCommandOptionsForArgs(args) {
  if (!isGuidedSetupArgs(args)) return {};
  return {
    defaultSetupMode: "create_starter",
    createStarterWorkflow: true,
    friendlyOutput: true,
    promptForCredentials: true
  };
}

function isGuidedSetupArgs(args) {
  if (args.includes("--template-only")) return false;
  if (boardValues(args)) return false;
  if (args.includes("--adopt-starter")) return false;

  const mode = normalizeSetupMode(optionValue(args, "--mode"));
  return mode !== "existing" && mode !== "adopt_starter";
}

function usesFriendlyErrors(command, args) {
  return command === "init" || (command === "setup" && isGuidedSetupArgs(args));
}

function normalizeSetupMode(mode) {
  if (!mode) return undefined;
  const normalized = mode.trim().replaceAll("-", "_");
  if (normalized === "starter" || normalized === "new_board") return "create_starter";
  return normalized;
}

async function envWithCliOverrides(env, args, options = {}) {
  const envFile = optionValue(args, "--dotenv") ?? optionValue(args, "--env-file");
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
  if (options.promptForCredentials) {
    if (!nonEmpty(overridden.FIZZY_API_URL)) {
      const promptedApiUrl = await promptInput(options.prompts, {
        name: "fizzy_api_url",
        message: "Fizzy API URL",
        defaultValue: DEFAULT_FIZZY_API_URL
      });
      if (nonEmpty(promptedApiUrl)) overridden.FIZZY_API_URL = promptedApiUrl;
    } else if (!apiUrl && !nonEmpty(env.FIZZY_API_URL) && !nonEmpty(fileEnv.FIZZY_API_URL)) {
      const promptedApiUrl = await promptInput(options.prompts, {
        name: "fizzy_api_url",
        message: "Fizzy API URL",
        defaultValue: overridden.FIZZY_API_URL
      });
      if (nonEmpty(promptedApiUrl)) overridden.FIZZY_API_URL = promptedApiUrl;
    }

    if (!nonEmpty(overridden.FIZZY_API_TOKEN)) {
      const promptedToken = await promptInput(options.prompts, {
        name: "fizzy_api_token",
        message: "Fizzy API token",
        secret: true
      });
      if (nonEmpty(promptedToken)) overridden.FIZZY_API_TOKEN = promptedToken;
    }
  }
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

function nonEmpty(value) {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
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
    `  fizzy-symphony start --config ${result.path}`,
    "",
    "Use it:",
    "  Create a normal Fizzy card in Ready for Agents.",
    "  The golden card is already the route; do not edit it for the smoke test.",
    ""
  ].join("\n");
}

function formatFriendlyError(error, command) {
  const lines = [
    `fizzy-symphony ${command} could not finish.`,
    "",
    error.message
  ];

  if (error.code) lines.push(`Code: ${error.code}`);

  const remediation = friendlyRemediation(error);
  if (remediation.length > 0) {
    lines.push("", "Next:", ...remediation.map((line) => `  ${line}`));
  }

  return `${lines.join("\n")}\n`;
}

function friendlyRemediation(error) {
  if (error.code === "FIZZY_CREDENTIALS_MISSING") {
    return [
      "Add FIZZY_API_TOKEN to .env in this workspace, then rerun `fizzy-symphony setup`.",
      "For self-hosted Fizzy, add FIZZY_API_URL=https://your-fizzy.example to the same .env.",
      "In an interactive terminal, setup will ask for missing values."
    ];
  }

  if (error.code === "FIZZY_IDENTITY_INVALID") {
    return [
      error.details?.remediation ?? "Check FIZZY_API_URL, network access, and Fizzy API availability, then rerun setup."
    ];
  }

  if (error.code === "RUNNER_UNAVAILABLE") {
    return [
      error.details?.remediation ?? "Install or expose the Codex CLI, then rerun setup."
    ];
  }

  if (error.details?.remediation) return [error.details.remediation];
  return [];
}

function promptProvider(io) {
  if (io.prompts) return io.prompts;
  return terminalPrompts(io);
}

async function promptInput(prompts, prompt) {
  if (!prompts?.input) return undefined;
  return prompts.input(prompt);
}

function terminalPrompts(io) {
  const input = io.stdin ?? process.stdin;
  const output = io.stdout ?? process.stdout;
  if (!input?.isTTY || !output?.isTTY) return null;

  return {
    async input(prompt) {
      if (prompt.secret && input.setRawMode) return promptSecret(input, output, prompt);
      return promptVisible(input, output, prompt);
    }
  };
}

async function promptVisible(input, output, prompt) {
  const rl = createInterface({ input, output });
  try {
    const suffix = prompt.defaultValue ? ` (${prompt.defaultValue})` : "";
    const answer = await rl.question(`${prompt.message}${suffix}: `);
    return answer.trim() || prompt.defaultValue || "";
  } finally {
    rl.close();
  }
}

function promptSecret(input, output, prompt) {
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    let value = "";

    const cleanup = () => {
      input.off("data", onData);
      if (!wasRaw) input.setRawMode(false);
      input.pause();
    };

    const finish = () => {
      cleanup();
      output.write("\n");
      resolve(value);
    };

    const abort = () => {
      cleanup();
      output.write("\n");
      reject(new Error("Interrupted"));
    };

    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\u0003") return abort();
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        value += char;
        output.write("*");
      }
    };

    output.write(`${prompt.message}: `);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
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
    "  fizzy-symphony init [--api-url url] [--token token] [--dotenv path] [--workspace-repo path]",
    "  fizzy-symphony setup [--api-url url] [--token token] [--dotenv path] [--workspace-repo path]",
    "  fizzy-symphony setup --template-only [--config path]",
    "  fizzy-symphony setup --mode existing [--config path] [--account id] [--board id] [--boards id,id] [--workspace-repo path]",
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
    stdin: process.stdin,
    env: process.env
  };
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isDirectInvocation() {
  return Boolean(process.argv[1]) &&
    canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
  process.exitCode = await main();
}
