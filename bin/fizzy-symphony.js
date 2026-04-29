#!/usr/bin/env node

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
    if (command === "setup") {
      return await setupCommand(args.slice(1), io);
    } else if (command === "validate") {
      return await validateCommand(args.slice(1), io);
    } else if (command === "daemon") {
      await daemonCommand(args.slice(1), io);
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
  const config = await loadConfig(configPath, { env: io.env ?? process.env });
  const discovery = await discoverStatusEndpoints(config, {
    instanceId,
    now: typeof io.now === "function" ? io.now() : new Date(),
    hostname: io.hostname,
    isPidAlive: io.isPidAlive
  });

  io.stdout.write(`${JSON.stringify({ ok: true, ...discovery })}\n`);
}

async function setupCommand(args, io) {
  const configPath = optionValue(args, "--config") ?? ".fizzy-symphony/config.yml";
  if (args.includes("--template-only")) {
    await writeAnnotatedConfig(configPath, { runnerPreferred: "cli_app_server" });
    io.stdout.write(`wrote annotated config: ${configPath}\n`);
    return 0;
  }

  const env = io.env ?? process.env;
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
    setupMode: optionValue(args, "--mode") ?? undefined,
    workspaceRepo: optionValue(args, "--workspace-repo") ?? ".",
    botUserId: optionValue(args, "--bot-user-id") ?? undefined,
    webhook: webhookOptions(args)
  });

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
  const env = io.env ?? process.env;
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

async function daemonCommand(args, io) {
  const configPath = optionValue(args, "--config") ?? ".fizzy-symphony/config.yml";
  const daemon = await startDaemon({
    configPath,
    env: io.env ?? process.env,
    signalProcess: io.signalProcess ?? process,
    ...(io.daemonOptions ?? {})
  });

  io.stdout.write(`${JSON.stringify({
    ok: true,
    command: "daemon",
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

function usage(exitCode, io) {
  const text = [
    "Usage:",
    "  fizzy-symphony setup --template-only [--config path]",
    "  fizzy-symphony setup [--config path] [--account id] [--board id] [--boards id,id] [--workspace-repo path]",
    "  fizzy-symphony validate [--parse-only] [--config path]",
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
