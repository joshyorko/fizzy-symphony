#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_FIZZY_API_URL, createCliFizzyClient, createCliRunner, resolveFizzyClientConfig } from "../src/client-factories.js";
import { writeOpener } from "../src/cli-opener.js";
import {
  ALLOWED_CODEX_REASONING_EFFORTS,
  loadConfig,
  writeAnnotatedConfig
} from "../src/config.js";
import { runDashboardCommand } from "../src/dashboard.js";
import { startDaemon } from "../src/daemon.js";
import { FizzySymphonyError, isFizzySymphonyError } from "../src/errors.js";
import { isRemoteGitUrl } from "../src/git-source-cache.js";
import { runSetup } from "../src/setup.js";
import { runStatusCommand } from "../src/status-cli.js";
import { discoverStatusEndpoints } from "../src/status-discovery.js";
import { createTerminalRenderer } from "../src/terminal-renderer.js";
import {
  createHumanDaemonLogger,
  formatDaemonStartSummary,
  formatSetupSuccess,
  supportsColor
} from "../src/terminal-ui.js";
import { validateStartup } from "../src/validation.js";
import { createLogger } from "../src/logger.js";

export async function main(args = process.argv.slice(2), io = defaultIo()) {
  const command = args[0]?.startsWith("-") ? undefined : args[0];
  const commandArgs = command ? args.slice(1) : args;

  try {
    if (isHelpCommand(args)) {
      return usage(0, io);
    } else if (!command) {
      if (!bareEntryArgsAllowed(commandArgs)) return usage(1, io);
      return await smartEntryCommand(commandArgs, io);
    } else if (command === "init") {
      return await initCommand(commandArgs, io);
    } else if (command === "setup") {
      return await setupCommand(commandArgs, io);
    } else if (command === "validate") {
      return await validateCommand(commandArgs, io);
    } else if (command === "boards") {
      return await boardsCommand(commandArgs, io);
    } else if (command === "daemon" || command === "start") {
      await daemonCommand(commandArgs, io, { commandName: command });
    } else if (command === "status") {
      if (args.includes("--config")) {
        await statusDiscoveryCommand(commandArgs, io);
        return 0;
      }
      return runStatusCommand(commandArgs, io);
    } else if (command === "dashboard") {
      return runDashboardCommand(commandArgs, io, { fetch: io.fetch });
    } else {
      return usage(1, io);
    }
    return 0;
  } catch (error) {
    if (usesFriendlyErrors(command, args.slice(1))) {
      io.stderr.write(formatFriendlyError(error, command, {
        color: supportsColor(io.env ?? process.env, io.stderr)
      }));
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
  io.stderr.write("fizzy-symphony init is deprecated; use `fizzy-symphony setup`.\n");
  return setupCommandWithOptions(args, io, {
    ...setupCommandOptionsForArgs(args),
    defaultSetupMode: "create_starter"
  });
}

async function smartEntryCommand(args, io) {
  const configPath = optionValue(args, "--config") ?? ".fizzy-symphony/config.yml";
  try {
    await access(configPath);
    return runDashboardCommand(args, io, { fetch: io.fetch });
  } catch {
    return setupCommand(args, io);
  }
}

async function setupCommandWithOptions(args, io, commandOptions = {}) {
  const configPath = optionValue(args, "--config") ?? ".fizzy-symphony/config.yml";
  if (args.includes("--template-only")) {
    await writeAnnotatedConfig(configPath, { runnerPreferred: "cli_app_server" });
    io.stdout.write(`wrote annotated config: ${configPath}\n`);
    return 0;
  }

  const baseEnv = io.env ?? process.env;
  if (commandOptions.requireSetupTty && !io.prompts && !isUsableSetupTty(io, baseEnv)) {
    throw new FizzySymphonyError("SETUP_TTY_REQUIRED", "Guided setup needs an interactive terminal.", {
      remediation: "Run `fizzy-symphony setup` from a TTY, or pass an explicit scripted mode such as `--mode existing --board <id>` or `--mode create-starter` with credentials."
    });
  }

  if (commandOptions.friendlyOutput) {
    await writeOpener(io, {
      env: baseEnv,
      frameDelayMs: io.openerFrameDelayMs
    });
  }

  const prompts = await promptProvider(io, commandOptions);
  try {
    const env = await envWithCliOverrides(baseEnv, args, {
      dotenvBasePath: setupDotenvBaseForArgs(args, baseEnv, configPath),
      promptForCredentials: commandOptions.promptForCredentials,
      prompts
    });
    const workspaceRepo = workspaceRepoForArgs(args, env);
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
      prompts,
      env,
      apiUrl: dependencyConfig.fizzy.api_url,
      account: optionValue(args, "--account") ?? undefined,
      selectedBoardIds: boardValues(args),
      setupMode: setupModeForArgs(args, commandOptions.defaultSetupMode),
      defaultModel: defaultModelForArgs(args, env),
      reasoningEffort: reasoningEffortForArgs(args, env),
      maxAgents: maxAgentsForArgs(args, env),
      workspaceMode: workspaceModeForArgs(args),
      workspaceRepo,
      workspaceRepoRef: workspaceRepoRefForArgs(args, env),
      sourceCacheRoot: sourceCacheRootForArgs(args, env),
      starterBoardName: optionValue(args, "--starter-board-name") ?? undefined,
      workflowPolicy: await workflowPolicyForArgs(args, prompts, workspaceRepo),
      createSmokeTestCard: args.includes("--smoke-card"),
      botUserId: optionValue(args, "--bot-user-id") ?? undefined,
      webhook: webhookOptions(args)
    });

    if (commandOptions.friendlyOutput) {
      io.stdout.write(formatSetupSuccess(result, {
        color: supportsColor(io.env ?? process.env, io.stdout)
      }));
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
  } finally {
    prompts?.close?.();
  }
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

async function boardsCommand(args, io) {
  const env = await envWithCliOverrides(io.env ?? process.env, args, {
    dotenvBasePath: optionValue(args, "--workspace-repo") ?? "."
  });
  const dependencyConfig = resolveFizzyClientConfig({
    config: {
      fizzy: { account: optionValue(args, "--account") ?? "" },
      runner: { preferred: "cli_app_server" }
    },
    env
  });
  const fizzy = await createFizzyDependency({ io, config: dependencyConfig, env });
  const identity = await fizzy.getIdentity?.();
  const account = optionValue(args, "--account") ?? firstAccountValue(identity) ?? dependencyConfig.fizzy.account;
  const boards = await fizzy.listBoards(account);
  const hydrated = [];

  for (const board of boards) {
    try {
      hydrated.push(await fizzy.getBoard(board.id, { account }));
    } catch {
      hydrated.push(board);
    }
  }

  io.stdout.write(formatBoardsList(hydrated, account, {
    color: supportsColor(io.env ?? process.env, io.stdout)
  }));
  return 0;
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

function firstAccountValue(identity = {}) {
  const account = identity.accounts?.[0];
  if (!account) return "";
  return normalizeAccountValue(account);
}

function normalizeAccountValue(account = {}) {
  const slug = String(account.slug ?? account.path ?? "").trim().replace(/^\/+|\/+$/gu, "");
  return slug || account.id || account.name || "";
}

function formatBoardsList(boards = [], account = "", options = {}) {
  const renderer = createTerminalRenderer(options);
  const lines = [
    renderer.title("Fizzy Symphony Boards", "Fizzy board inventory for golden-ticket routing"),
    "",
    renderer.section("Overview"),
    renderer.kvRows([
      ...(account ? [["Account", account]] : []),
      ["Boards", boards.length]
    ])
  ];
  if (boards.length === 0) {
    lines.push("", renderer.callout("warning", "No boards found."));
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    "",
    renderer.section("Boards"),
    renderer.table(["Board", "ID", "Columns", "Golden tickets"], boards.map((board) => {
      const goldenCards = (board.cards ?? []).filter((card) => card.golden);
      return [
        board.name ?? board.label ?? board.id,
        board.id ?? "unknown",
        (board.columns ?? []).length,
        goldenCardTitles(goldenCards).join(", ") || "-"
      ];
    })),
    "",
    renderer.section("Details")
  );

  for (const board of boards) {
    const boardName = board.name ?? board.label ?? board.id;
    const goldenCards = (board.cards ?? []).filter((card) => card.golden);
    lines.push(`  ${boardName} (${board.id ?? "unknown"})`);
    const columns = board.columns ?? [];
    lines.push(indentBlock(renderer.kvRows([
      ["Columns", columns.length],
      ["Golden tickets", goldenCardTitles(goldenCards).join(", ") || "-"]
    ], { width: 16 })));
    if (columns.length > 0) {
      for (const column of columns) {
        lines.push(`    ${column.name ?? column.title ?? column.id} (${column.id ?? "unknown"})`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function goldenCardTitles(cards = []) {
  return cards.map((card) => card.title ?? card.name ?? card.id).filter(Boolean);
}

function indentBlock(text, prefix = "  ") {
  return String(text).split("\n").map((line) => `${prefix}${line}`).join("\n");
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
  const daemonOptions = io.daemonOptions ?? {};
  const logger = daemonOptions.dependencies?.logger ?? io.logger ?? createDaemonLogger(io);
  const dependencies = {
    ...(daemonOptions.dependencies ?? {}),
    logger
  };
  const daemon = await startDaemon({
    configPath,
    env,
    signalProcess: io.signalProcess ?? process,
    ...daemonOptions,
    dependencies
  });

  if (isInteractiveStderr(io)) {
    const boardSnapshots = await readDaemonBoardSnapshots(daemon);
    io.stderr.write(formatDaemonStartSummary(daemon, {
      color: supportsColor(io.env ?? process.env, io.stderr),
      configPath,
      boardSnapshots
    }));
  }
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

async function readDaemonBoardSnapshots(daemon) {
  const boards = daemon.status.status().watched_boards ?? [];
  const account = daemon.config.fizzy?.account;
  const snapshots = [];

  for (const board of boards) {
    try {
      const snapshot = await daemon.fizzy?.getBoard?.(board.id, { account });
      if (snapshot) snapshots.push(snapshot);
    } catch {
      // Startup should not fail because the optional terminal snapshot failed.
    }
  }

  return snapshots;
}

function createDaemonLogger(io) {
  if (isInteractiveStderr(io)) return createHumanDaemonLogger(io);
  return createLogger({ writer: io.stderr });
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

function setupDotenvBaseForArgs(args, env, configPath) {
  const repo = explicitWorkspaceRepoForArgs(args) ?? firstNonEmpty(env.FIZZY_SYMPHONY_REPO);
  if (nonEmpty(repo) && !isRemoteGitUrl(repo)) return repo;
  return envBaseForConfig(configPath);
}

function explicitWorkspaceRepoForArgs(args) {
  return optionValue(args, "--repo") ??
    optionValue(args, "--git-repo") ??
    optionValue(args, "--workspace-repo");
}

function workspaceRepoForArgs(args, env = process.env) {
  return explicitWorkspaceRepoForArgs(args) ??
    firstNonEmpty(env.FIZZY_SYMPHONY_REPO) ??
    ".";
}

function workspaceRepoRefForArgs(args, env = process.env) {
  return optionValue(args, "--ref") ??
    optionValue(args, "--repo-ref") ??
    firstNonEmpty(env.FIZZY_SYMPHONY_REPO_REF);
}

function sourceCacheRootForArgs(args, env = process.env) {
  return optionValue(args, "--source-cache") ??
    firstNonEmpty(env.FIZZY_SYMPHONY_SOURCE_CACHE);
}

function setupModeForArgs(args, defaultMode) {
  if (args.includes("--starter") || args.includes("--new-board")) return "create_starter";
  if (args.includes("--adopt-starter")) return "adopt_starter";
  return normalizeSetupMode(optionValue(args, "--mode") ?? defaultMode);
}

function defaultModelForArgs(args, env = process.env) {
  return optionValue(args, "--model") ??
    optionValue(args, "--codex-model") ??
    firstNonEmpty(env.FIZZY_SYMPHONY_CODEX_MODEL, env.CODEX_MODEL);
}

function reasoningEffortForArgs(args, env = process.env) {
  const raw = optionValue(args, "--reasoning-effort") ??
    optionValue(args, "--reasoning") ??
    firstNonEmpty(env.FIZZY_SYMPHONY_REASONING_EFFORT, env.CODEX_REASONING_EFFORT);
  if (!nonEmpty(raw)) return undefined;

  const value = String(raw).trim();

  if (!ALLOWED_CODEX_REASONING_EFFORTS.includes(value)) {
    throw new FizzySymphonyError("INVALID_REASONING_EFFORT", "--reasoning-effort must be low, medium, high, or xhigh.", {
      value,
      allowed: ALLOWED_CODEX_REASONING_EFFORTS,
      remediation: "Use a value like `--reasoning-effort high`, or omit it for medium."
    });
  }

  return value;
}

function workspaceModeForArgs(args) {
  if (args.includes("--no-dispatch")) return "no_dispatch";
  if (args.includes("--worktree") || args.includes("--protected-worktree")) return "protected_worktree";
  return undefined;
}

function maxAgentsForArgs(args, env = process.env) {
  const raw = optionValue(args, "--max-agents") ??
    optionValue(args, "--max-concurrent") ??
    firstNonEmpty(env.FIZZY_SYMPHONY_MAX_AGENTS);
  if (!nonEmpty(raw)) return undefined;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new FizzySymphonyError("INVALID_MAX_AGENTS", "--max-agents must be a positive integer.", {
      value: raw,
      remediation: "Use a value like `--max-agents 1` for a starter board or a small positive integer for parallel agents."
    });
  }

  return value;
}

function setupCommandOptionsForArgs(args) {
  if (!isImplicitGuidedSetupArgs(args)) {
    if (needsGuidedBoardSelection(args)) {
      return {
        promptForCredentials: true,
        guidedSetup: true
      };
    }
    return {};
  }
  return {
    friendlyOutput: true,
    promptForCredentials: true,
    guidedSetup: true,
    requireSetupTty: true
  };
}

async function workflowPolicyForArgs(args, prompts, workspaceRepo) {
  if (isRemoteGitUrl(workspaceRepo)) return { action: "skip" };
  if (args.includes("--create-starter-workflow") || args.includes("--starter-workflow")) return { action: "create" };
  if (args.includes("--augment-workflow")) return { action: "append" };
  if (args.includes("--no-workflow-change")) return { action: "skip" };
  const prompted = await promptWorkflowPolicy(prompts, workspaceRepo);
  if (prompted) return prompted;
  return { action: "skip" };
}

async function promptWorkflowPolicy(prompts, workspaceRepo) {
  if (isRemoteGitUrl(workspaceRepo)) return { action: "skip" };
  const workflowPath = join(workspaceRepo, "WORKFLOW.md");
  const exists = await pathExists(workflowPath);
  if (prompts?.confirmWorkflowPolicy) {
    return prompts.confirmWorkflowPolicy({ exists, path: workflowPath });
  }
  if (!prompts?.input) return null;
  const defaultValue = exists ? "leave" : "skip";
  const answer = await prompts.input({
    name: "workflow_action",
    message: exists
      ? "WORKFLOW.md action: leave, append, or skip"
      : "WORKFLOW.md action: type create or yes to create, or press Enter to skip",
    defaultValue
  });
  const normalized = String(answer || defaultValue).trim().toLowerCase();
  if (normalized === "create" || normalized === "yes") return { action: "create" };
  if (normalized === "append" || normalized === "augment") return { action: "append" };
  return { action: "skip" };
}

const BARE_ENTRY_VALUE_FLAGS = new Set([
  "--config",
  "--endpoint",
  "--registry-dir",
  "--instance",
  "--refresh-ms"
]);
const BARE_ENTRY_BOOLEAN_FLAGS = new Set([
  "--once",
  "--no-default-endpoint"
]);

function bareEntryArgsAllowed(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-")) return false;
    if (BARE_ENTRY_VALUE_FLAGS.has(arg)) {
      if (!args[index + 1] || args[index + 1].startsWith("-")) return false;
      index += 1;
      continue;
    }
    if (BARE_ENTRY_BOOLEAN_FLAGS.has(arg)) continue;
    return false;
  }
  return true;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isImplicitGuidedSetupArgs(args) {
  if (args.includes("--template-only")) return false;
  if (boardValues(args)) return false;
  if (args.includes("--starter") || args.includes("--new-board")) return false;
  if (args.includes("--adopt-starter")) return false;
  return !optionValue(args, "--mode");
}

function needsGuidedBoardSelection(args) {
  if (args.includes("--template-only")) return false;
  if (boardValues(args)) return false;
  if (args.includes("--adopt-starter")) return true;
  const mode = normalizeSetupMode(optionValue(args, "--mode"));
  return mode === "existing" || mode === "adopt_starter";
}

function usesFriendlyErrors(command, args) {
  return command === "init" || (command === "setup" && isImplicitGuidedSetupArgs(args));
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

function isInteractiveStderr(io) {
  return Boolean(io.stderr?.isTTY) && !nonEmpty(io.env?.CI);
}

function formatFriendlyError(error, command, options = {}) {
  const renderer = createTerminalRenderer(options);
  const label = error.code === "SETUP_TTY_REQUIRED" || error.code === "FIZZY_CREDENTIALS_MISSING"
    ? "needs input"
    : "stopped";
  const lines = [
    renderer.title("Fizzy Symphony Setup", "Guided first-run configuration"),
    `${renderer.badge(label === "needs input" ? "warning" : "error", label)} fizzy-symphony ${command} could not finish.`,
    "",
    renderer.section("Issue"),
    renderer.kvRows([
      ["Message", error.message],
      ...(error.code ? [["Code", error.code]] : [])
    ])
  ];

  const remediation = friendlyRemediation(error);
  if (remediation.length > 0) {
    lines.push("", renderer.section("Next steps"), ...remediation.map((line) => `  ${line}`));
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

  if (error.code === "SETUP_TTY_REQUIRED") {
    return [
      "Run `fizzy-symphony setup` from an interactive terminal for the guided wizard.",
      "For scripts, pass an explicit mode such as `--mode existing --board <id>` or `--mode create-starter` with FIZZY_API_URL and FIZZY_API_TOKEN."
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

async function promptProvider(io, options = {}) {
  if (io.prompts) return io.prompts;

  if (!options.guidedSetup) return null;

  const env = io.env ?? process.env;
  if (isUsableSetupTty(io, env)) {
    const provider = await setupWizardPromptProvider(io, env);
    if (provider) return provider;
  }
  if (options.requireSetupTty) {
    throw new FizzySymphonyError("SETUP_TTY_REQUIRED", "Guided setup needs an interactive terminal.", {
      remediation: "Run `fizzy-symphony setup` from a TTY, or pass an explicit scripted mode such as `--mode existing --board <id>` or `--mode create-starter` with credentials."
    });
  }

  return null;
}

async function promptInput(prompts, prompt) {
  if (!prompts?.input) return undefined;
  return prompts.input(prompt);
}

function isUsableSetupTty(io, env = process.env) {
  if (env.CI) return false;
  if (env.TERM === "dumb") return false;
  const input = io.stdin ?? process.stdin;
  const output = io.stdout ?? process.stdout;
  return Boolean(input?.isTTY) &&
    Boolean(output?.isTTY) &&
    input === process.stdin &&
    output === process.stdout;
}

async function setupWizardPromptProvider(io, env) {
  const { createSetupWizardPromptProvider } = await import("../src/setup-wizard.js");
  return createSetupWizardPromptProvider(io, env);
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
    "  fizzy-symphony setup",
    "  fizzy-symphony setup --template-only [--config path]",
    "  fizzy-symphony setup --mode create-starter [--api-url url] [--token token] [--dotenv path] [--repo url|--git-repo url|--workspace-repo path-or-url] [--ref ref] [--source-cache path] [--model model] [--reasoning-effort level] [--max-agents n] [--worktree|--no-dispatch] [--create-starter-workflow|--no-workflow-change]",
    "  fizzy-symphony setup --mode existing [--config path] [--account id] [--board id] [--boards id,id] [--repo url|--git-repo url|--workspace-repo path-or-url] [--augment-workflow|--no-workflow-change]",
    "  fizzy-symphony setup --adopt-starter --board id [--config path] [--account id] [--repo url|--git-repo url|--workspace-repo path-or-url] [--augment-workflow|--no-workflow-change]",
    "  fizzy-symphony validate [--parse-only] [--config path]",
    "  fizzy-symphony start [--config path]",
    "  fizzy-symphony daemon [--config path]",
    "  fizzy-symphony boards [--api-url url] [--token token] [--account id]",
    "  fizzy-symphony dashboard [--config path] [--endpoint url] [--registry-dir path] [--refresh-ms n]",
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
