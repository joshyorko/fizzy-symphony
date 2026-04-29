#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { loadConfig, writeAnnotatedConfig } from "../src/config.js";
import { isFizzySymphonyError } from "../src/errors.js";
import { runStatusCommand } from "../src/status-cli.js";
import { discoverStatusEndpoints } from "../src/status-discovery.js";

export async function main(args = process.argv.slice(2), io = defaultIo()) {
  const command = args[0];

  try {
    if (command === "setup") {
      await setupCommand(args.slice(1), io);
    } else if (command === "validate") {
      await validateCommand(args.slice(1), io);
    } else if (command === "daemon") {
      daemonCommand(io);
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
  const configPath = optionValue(args, "--config") ?? ".fizzy-symphony/config.json";
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
  if (!args.includes("--template-only")) {
    throw new Error("Task 1 CLI setup supports --template-only. Validating live Fizzy setup uses injected clients in src/setup.js.");
  }

  await writeAnnotatedConfig(configPath, { runnerPreferred: "cli_app_server" });
  io.stdout.write(`wrote annotated config: ${configPath}\n`);
}

async function validateCommand(args, io) {
  const configPath = optionValue(args, "--config") ?? ".fizzy-symphony/config.json";
  if (!args.includes("--parse-only")) {
    throw new Error("Task 1 CLI validate supports --parse-only. Full startup validation requires injected Fizzy and runner clients.");
  }

  await loadConfig(configPath, { env: io.env ?? process.env });
  io.stdout.write(`${JSON.stringify({ ok: true, mode: "parse-only" })}\n`);
}

function daemonCommand(io) {
  io.stdout.write(`${JSON.stringify({
    ok: true,
    command: "daemon",
    status: "stub",
    message: "Later tasks implement the daemon loop."
  })}\n`);
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function usage(exitCode, io) {
  const text = [
    "Usage:",
    "  fizzy-symphony setup --template-only [--config path]",
    "  fizzy-symphony validate --parse-only [--config path]",
    "  fizzy-symphony daemon",
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
