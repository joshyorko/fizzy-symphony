import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { FizzySymphonyError } from "./errors.js";
import { hasEmbeddedGitCredentials, isRemoteGitUrl, redactGitRemoteUrl } from "./git-source-cache.js";

const TEMPLATE_PATH = new URL("../config.example.yml", import.meta.url);
const DEFAULT_FIZZY_API_URL = "https://app.fizzy.do";
const DEFAULT_SETUP_IGNORED_DIRTY_PATHS = [".fizzy-symphony/"];
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_REASONING_EFFORT = "medium";
export const ALLOWED_CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];

const allowedCardOverridesSchema = {
  backend: true,
  model: true,
  workspace: true,
  persona: true,
  priority: true,
  completion: true
};

const boardEntrySchema = {
  id: true,
  label: true,
  enabled: true,
  routing_mode: true,
  defaults: {
    backend: true,
    model: true,
    workspace: true,
    persona: true,
    unknown_managed_tag_policy: true,
    allowed_card_overrides: allowedCardOverridesSchema,
    concurrency: { max_concurrent: true }
  }
};

const workspaceEntrySchema = {
  repo: true,
  source: true,
  isolation: true,
  base_ref: true,
  worktree_root: true,
  branch_prefix: true,
  workflow_path: true,
  require_clean_source: true
};

const workspaceSourceSchema = {
  type: true,
  remote_url: true,
  base_ref: true,
  fetch_depth: true,
  auth: true
};

const schema = {
  instance: {
    id: true,
    label: true
  },
  fizzy: {
    token: true,
    account: true,
    api_url: true,
    bot_user_id: true
  },
  boards: {
    entries: [boardEntrySchema]
  },
  server: {
    host: true,
    port: true,
    port_allocation: true,
    base_port: true,
    registry_dir: true,
    heartbeat_interval_ms: true
  },
  webhook: {
    enabled: true,
    path: true,
    secret: true,
    max_event_age_seconds: true,
    manage: true,
    managed_webhook_ids_by_board: { __map: true },
    callback_url: true,
    subscribed_actions: [true]
  },
  polling: {
    interval_ms: true,
    use_etags: true,
    use_api_filters: true,
    api_filters: {
      board_ids: [true],
      column_ids: [true],
      tag_ids: [true],
      assignee_ids: [true],
      assignment_status: true,
      indexed_by: true,
      sorted_by: true,
      terms: [true]
    }
  },
  agent: {
    max_concurrent: true,
    max_concurrent_per_card: true,
    turn_timeout_ms: true,
    stall_timeout_ms: true,
    max_turns: true,
    max_retry_backoff_ms: true,
    default_backend: true,
    default_model: true,
    reasoning_effort: true,
    default_persona: true
  },
  runner: {
    preferred: true,
    fallback: true,
    allow_fallback: true,
    sdk: {
      package: true,
      contract: true,
      smoke_test: true
    },
    cli_app_server: {
      command: true,
      args: [true]
    },
    initialize_timeout_ms: true,
    request_timeout_ms: true,
    cancel_timeout_ms: true,
    stop_session_timeout_ms: true,
    terminate_timeout_ms: true,
    kill_timeout_ms: true,
    stream_timeout_ms: true,
    max_stderr_bytes: true,
    health: {
      enabled: true,
      interval_ms: true
    },
    codex: {
      approval_policy: {
        mode: true,
        sandbox_approval: true,
        command_approval: true,
        tool_approval: true,
        mcp_elicitation: true
      },
      interactive: true,
      thread_sandbox: true,
      turn_sandbox_policy: {
        type: true
      }
    }
  },
  workspaces: {
    root: true,
    metadata_root: true,
    default_isolation: true,
    source_cache_root: true,
    sources: { __map: workspaceSourceSchema },
    default_repo: true,
    registry: { __map: workspaceEntrySchema },
    retry: {
      workspace_policy: true
    }
  },
  workflow: {
    create_starter_on_setup: true,
    fallback_enabled: true,
    fallback_path: true
  },
  routing: {
    allow_postponed_cards: true,
    rerun: {
      mode: true,
      agent_rerun_consumption: true
    }
  },
  diagnostics: {
    no_dispatch: true
  },
  claims: {
    mode: true,
    tag_visibility: true,
    tag: true,
    assign_on_claim: true,
    watch_on_claim: true,
    lease_ms: true,
    renew_interval_ms: true,
    steal_grace_ms: true,
    max_clock_skew_ms: true
  },
  completion: {
    allow_card_completion_override: true,
    markers: {
      mode: true,
      success_tag_prefix: true,
      failure_tag_prefix: true
    }
  },
  workpad: {
    enabled: true,
    mode: true,
    update_interval_ms: true
  },
  safety: {
    allowed_roots: [true],
    ignored_dirty_paths: [true],
    dirty_source_repo_policy: true,
    cleanup: {
      policy: true,
      require_proof_before_cleanup: true,
      require_handoff_before_cleanup: true,
      forbid_force_remove: true,
      retention_ms: true
    }
  },
  observability: {
    state_dir: true,
    log_dir: true,
    status_snapshot_path: true,
    status_retention_ms: true,
    log_format: true
  }
};

export function generateAnnotatedConfig(options = {}) {
  const {
    account = "my-account",
    board = { id: "board_123", label: "Agent Playground" },
    boards,
    agentMaxConcurrent = 2,
    boardMaxConcurrent = agentMaxConcurrent,
    runnerPreferred = "cli_app_server",
    runnerFallback = "cli_app_server",
    sdkPackage = "",
    sdkContract = "",
    apiUrl = DEFAULT_FIZZY_API_URL,
    botUserId = "",
    defaultModel = DEFAULT_CODEX_MODEL,
    reasoningEffort = DEFAULT_CODEX_REASONING_EFFORT,
    webhook = {},
    managedWebhookIdsByBoard = webhook.managed_webhook_ids_by_board ?? {},
    configDir = ".",
    workspaceRepo = ".",
    workspaceRepoRef,
    sourceCacheRoot,
    allowedRoots
  } = options;

  const boardEntries = boards?.length ? boards : [board];
  const workspaceRepoPath = relativePathForConfig(configDir, workspaceRepo);
  const remoteWorkspaceRepo = isRemoteGitUrl(workspaceRepo);
  const sourceCachePath = relativePathForConfig(
    configDir,
    sourceCacheRoot ?? resolve(configDir, defaultLocalPathForConfig(".fizzy-symphony/sources", configDir))
  );
  const safetyAllowedRoots = allowedRoots?.length
    ? allowedRoots
    : uniqueStrings(remoteWorkspaceRepo ? [sourceCachePath, "."] : [workspaceRepoPath, "."]);
  let template = readFileSync(TEMPLATE_PATH, "utf8");
  template = template.replace(/account: my-account/u, `account: ${yamlScalar(account)}`);
  template = template.replace(/api_url: https:\/\/app\.fizzy\.do/u, `api_url: ${yamlScalar(apiUrl)}`);
  template = template.replace(
    /  entries:\n[\s\S]*?\nserver:/u,
    `  entries:\n${renderBoardEntries(boardEntries, boardMaxConcurrent, defaultModel)}\nserver:`
  );
  template = template.replace(/\n  max_concurrent: 2\n/u, `\n  max_concurrent: ${agentMaxConcurrent}\n`);
  template = template.replace(/default_model: gpt-5\.5|default_model: ""/u, `default_model: ${yamlScalar(defaultModel)}`);
  template = template.replace(/reasoning_effort: medium/u, `reasoning_effort: ${yamlScalar(reasoningEffort)}`);
  template = template.replace(/bot_user_id: ""/u, `bot_user_id: ${yamlScalar(botUserId)}`);
  template = template.replace(/preferred: sdk/u, `preferred: ${yamlScalar(runnerPreferred)}`);
  template = template.replace(/fallback: cli_app_server/u, `fallback: ${yamlScalar(runnerFallback)}`);
  template = template.replace(/package: ""/u, `package: ${yamlScalar(sdkPackage)}`);
  template = template.replace(/contract: ""/u, `contract: ${yamlScalar(sdkContract)}`);
  template = template.replace(/secret: \$FIZZY_WEBHOOK_SECRET/u, `secret: ${yamlScalar(webhook.secret_env ? `$${webhook.secret_env}` : "")}`);
  if (remoteWorkspaceRepo) {
    template = template.replace(/default_repo: \./u, `default_repo: ${yamlScalar(".")}`);
    template = template.replace(
      /  registry:\n    app:\n      repo: \.\n/u,
      [
        `  source_cache_root: ${yamlScalar(sourceCachePath)}`,
        "  sources:",
        "    app:",
        "      type: git_remote",
        `      remote_url: ${yamlScalar(redactGitRemoteUrl(workspaceRepo))}`,
        `      base_ref: ${yamlScalar(workspaceRepoRef ?? "main")}`,
        "      fetch_depth: 0",
        "      auth: auto",
        "  registry:",
        "    app:",
        "      source: app"
      ].join("\n") + "\n"
    );
  } else {
    template = template.replace(/default_repo: \./u, `default_repo: ${yamlScalar(workspaceRepoPath)}`);
    template = template.replace(/\n      repo: \.\n/u, `\n      repo: ${yamlScalar(workspaceRepoPath)}\n`);
  }
  template = template.replace(
    /  allowed_roots:\n(?:    - .+\n)+/u,
    `  allowed_roots:\n${renderStringList(safetyAllowedRoots, 4)}\n`
  );

  if (Object.hasOwn(webhook, "manage")) {
    template = template.replace(/manage: false/u, `manage: ${Boolean(webhook.manage)}`);
  }
  if (Object.keys(managedWebhookIdsByBoard).length > 0) {
    template = template.replace(
      /managed_webhook_ids_by_board: \{\}/u,
      `managed_webhook_ids_by_board:\n${renderStringMap(managedWebhookIdsByBoard, 4)}`
    );
  }
  if (webhook.callback_url) {
    template = template.replace(/callback_url: ""/u, `callback_url: ${yamlScalar(webhook.callback_url)}`);
  }

  return template;
}

export function generateOperatorConfig(options = {}) {
  const {
    account = "my-account",
    board = { id: "board_123", label: "Agent Playground" },
    boards,
    agentMaxConcurrent = 1,
    boardMaxConcurrent = agentMaxConcurrent,
    runnerPreferred = "cli_app_server",
    apiUrl = DEFAULT_FIZZY_API_URL,
    botUserId = "",
    defaultModel = DEFAULT_CODEX_MODEL,
    reasoningEffort = DEFAULT_CODEX_REASONING_EFFORT,
    webhook = {},
    managedWebhookIdsByBoard = webhook.managed_webhook_ids_by_board ?? {},
    configDir = ".",
    workspaceRepo = ".",
    workspaceRepoRef,
    sourceCacheRoot,
    noDispatch = false,
    ignoredDirtyPaths = DEFAULT_SETUP_IGNORED_DIRTY_PATHS
  } = options;

  const boardEntries = boards?.length ? boards : [board];
  const workspaceRepoPath = relativePathForConfig(configDir, workspaceRepo);
  const remoteWorkspaceRepo = isRemoteGitUrl(workspaceRepo);
  const sourceCachePath = relativePathForConfig(
    configDir,
    sourceCacheRoot ?? resolve(configDir, defaultLocalPathForConfig(".fizzy-symphony/sources", configDir))
  );

  const lines = [
    "# fizzy-symphony",
    "# Golden-ticket cards define the workflow. This file only tells the watcher where to run.",
    "",
    "fizzy:",
    "  token: $FIZZY_API_TOKEN",
    `  account: ${yamlScalar(account)}`,
    `  api_url: ${yamlScalar(apiUrl)}`,
    ...(botUserId ? [`  bot_user_id: ${yamlScalar(botUserId)}`] : []),
    "",
    "boards:",
    "  entries:",
    renderCompactBoardEntries(boardEntries, { maxConcurrent: boardMaxConcurrent, defaultModel }),
    "",
    "agent:",
    `  max_concurrent: ${agentMaxConcurrent}`,
    "  # Codex model sent to the Codex app-server.",
    `  default_model: ${yamlScalar(defaultModel)}`,
    "  # Codex reasoning effort: low, medium, high, xhigh.",
    `  reasoning_effort: ${yamlScalar(reasoningEffort)}`,
    "",
    "runner:",
    `  preferred: ${yamlScalar(runnerPreferred)}`,
    ...compactWebhookLines(webhook, managedWebhookIdsByBoard),
    "",
    "polling:",
    "  interval_ms: 30000",
    ...(noDispatch ? [
      "",
      "diagnostics:",
      "  # Setup workspace mode was no-dispatch; start will watch status but not run agents.",
      "  no_dispatch: true"
    ] : []),
    "",
    "workspaces:",
    ...(remoteWorkspaceRepo
      ? [
        `  source_cache_root: ${yamlScalar(sourceCachePath)}`,
        "  sources:",
        "    app:",
        "      type: git_remote",
        `      remote_url: ${yamlScalar(redactGitRemoteUrl(workspaceRepo))}`,
        `      base_ref: ${yamlScalar(workspaceRepoRef ?? "main")}`,
        "      fetch_depth: 0",
        "      auth: auto"
      ]
      : [`  default_repo: ${yamlScalar(workspaceRepoPath)}`]),
    "  registry:",
    "    app:",
    ...(remoteWorkspaceRepo ? ["      source: app"] : [`      repo: ${yamlScalar(workspaceRepoPath)}`]),
    ...(remoteWorkspaceRepo ? [] : ["      base_ref: HEAD"]),
    "      workflow_path: WORKFLOW.md",
    "      require_clean_source: true",
    "",
    "workflow:",
    "  # No repo WORKFLOW.md is required; the built-in fallback keeps the golden ticket primary.",
    "  fallback_enabled: true",
    "",
    "safety:",
    "  allowed_roots:",
    renderStringList(uniqueStrings(remoteWorkspaceRepo ? [sourceCachePath, "."] : [workspaceRepoPath, "."]), 4),
    "  dirty_source_repo_policy: fail",
    "  ignored_dirty_paths:",
    renderStringList(ignoredDirtyPaths, 4)
  ];

  return `${lines.join("\n")}\n`;
}

export async function writeAnnotatedConfig(configPath, options = {}) {
  await mkdir(dirname(configPath), { recursive: true });
  const generated = generateAnnotatedConfig({
    ...options,
    configDir: options.configDir ?? dirname(configPath)
  });
  await writeFile(configPath, generated, "utf8");
  return { path: configPath, bytes: Buffer.byteLength(generated) };
}

export async function writeOperatorConfig(configPath, options = {}) {
  await mkdir(dirname(configPath), { recursive: true });
  const generated = generateOperatorConfig({
    ...options,
    configDir: options.configDir ?? dirname(configPath)
  });
  await writeFile(configPath, generated, "utf8");
  return { path: configPath, bytes: Buffer.byteLength(generated) };
}

export async function loadConfig(configPath, options = {}) {
  const extension = extname(configPath).toLowerCase();
  if (![".json", ".yml", ".yaml"].includes(extension)) {
    throw new FizzySymphonyError(
      "CONFIG_UNSUPPORTED_FORMAT",
      "Config files must use JSON or the generated YAML format.",
      { path: configPath, extension }
    );
  }

  let parsed;
  try {
    const text = await readFile(configPath, "utf8");
    parsed = extension === ".json" ? JSON.parse(text) : parseGeneratedYaml(text, configPath);
  } catch (error) {
    if (isFizzySymphonyError(error)) throw error;
    throw new FizzySymphonyError("CONFIG_PARSE_ERROR", `Unable to parse config: ${error.message}`, {
      path: configPath
    });
  }

  return parseConfig(parsed, { ...options, configPath });
}

export function parseConfig(input, options = {}) {
  const configPath = options.configPath ?? join(process.cwd(), "config.json");
  validateKnownKeys(input, schema);

  const resolved = resolveEnvironmentReferences(applyConfigDefaults(input, { configDir: dirname(configPath) }), options.env ?? process.env);
  validateConfigValues(resolved);
  resolveRelativePaths(resolved, dirname(configPath));
  return resolved;
}

function validateConfigValues(config) {
  validateEnum(config.safety?.cleanup?.policy, ["preserve", "remove_clean_only", "archive_after_retention"], "safety.cleanup.policy");
  validateEnum(config.claims?.mode, ["structured_comment"], "claims.mode");
  validateEnum(config.runner?.preferred, ["sdk", "cli_app_server"], "runner.preferred");
  validateEnum(config.runner?.fallback, ["cli_app_server", "none"], "runner.fallback");
  validateEnum(config.agent?.reasoning_effort, ALLOWED_CODEX_REASONING_EFFORTS, "agent.reasoning_effort");
  validateEnum(config.server?.port_allocation, ["fixed", "next_available", "random"], "server.port_allocation");
  validateWorkspaceIsolation(config.workspaces?.default_isolation, "workspaces.default_isolation");
  for (const [name, workspace] of Object.entries(config.workspaces?.registry ?? {})) {
    validateWorkspaceIsolation(workspace?.isolation, `workspaces.registry.${name}.isolation`);
    if (workspace?.source && !config.workspaces?.sources?.[workspace.source]) {
      throw new FizzySymphonyError("CONFIG_INVALID_WORKSPACE_SOURCE", "Workspace source must reference a declared workspaces.sources entry.", {
        path: `workspaces.registry.${name}.source`,
        value: workspace.source
      });
    }
  }
  for (const [name, source] of Object.entries(config.workspaces?.sources ?? {})) {
    validateWorkspaceSource(source, `workspaces.sources.${name}`);
  }

  validateServerPort(config.server ?? {});

  for (const path of durationPaths()) {
    const value = getPath(config, path);
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new FizzySymphonyError("CONFIG_INVALID_DURATION", `Config duration must be a positive integer: ${path}`, {
        path,
        value
      });
    }
  }

  if (config.webhook?.manage && !config.webhook?.callback_url) {
    throw new FizzySymphonyError("CONFIG_INVALID_WEBHOOK", "webhook.manage requires webhook.callback_url.", {
      path: "webhook.callback_url"
    });
  }
}

function validateEnum(value, allowed, path) {
  if (value === undefined) return;
  if (!allowed.includes(value)) {
    throw new FizzySymphonyError("CONFIG_INVALID_ENUM", `Invalid enum value at ${path}.`, {
      path,
      value,
      allowed
    });
  }
}

function validateWorkspaceIsolation(value, path) {
  if (value === undefined) return;
  validateEnum(value, ["git_worktree", "git_clone", "copy"], path);
  if (value !== "git_worktree") {
    throw new FizzySymphonyError(
      "CONFIG_UNIMPLEMENTED_FEATURE",
      "Only git_worktree workspace isolation is implemented for live daemon dispatch.",
      { path, value, supported: ["git_worktree"] }
    );
  }
}

function validateWorkspaceSource(source = {}, path) {
  if (!source.type) return;
  validateEnum(source.type, ["git_remote"], `${path}.type`);
  validateEnum(source.auth, ["auto", "gh"], `${path}.auth`);
  if (!source.remote_url) {
    throw new FizzySymphonyError("CONFIG_INVALID_WORKSPACE_SOURCE", "Remote workspace sources require remote_url.", {
      path: `${path}.remote_url`
    });
  }
  if (!isRemoteGitUrl(source.remote_url)) {
    throw new FizzySymphonyError("CONFIG_INVALID_WORKSPACE_SOURCE", "Remote workspace source remote_url must be a supported Git URL.", {
      path: `${path}.remote_url`,
      value: redactGitRemoteUrl(source.remote_url)
    });
  }
  if (hasEmbeddedGitCredentials(source.remote_url)) {
    throw new FizzySymphonyError("CONFIG_INVALID_WORKSPACE_SOURCE", "Remote workspace source remote_url must not embed credentials.", {
      path: `${path}.remote_url`,
      value: redactGitRemoteUrl(source.remote_url),
      remediation: "Remove credentials from the Git URL and use a Git credential helper or host authentication."
    });
  }
  if (!Number.isInteger(source.fetch_depth) || source.fetch_depth < 0) {
    throw new FizzySymphonyError("CONFIG_INVALID_WORKSPACE_SOURCE", "Remote workspace source fetch_depth must be a non-negative integer.", {
      path: `${path}.fetch_depth`,
      value: source.fetch_depth
    });
  }
}

function validateServerPort(server) {
  const portAllocation = server.port_allocation;
  if (server.port !== undefined && !isValidPortValue(server.port)) {
    throw new FizzySymphonyError("CONFIG_INVALID_SERVER_PORT", "server.port must be auto or a valid TCP port.", {
      path: "server.port",
      value: server.port
    });
  }
  if (server.base_port !== undefined && !isTcpPort(server.base_port)) {
    throw new FizzySymphonyError("CONFIG_INVALID_SERVER_PORT", "server.base_port must be a valid TCP port.", {
      path: "server.base_port",
      value: server.base_port
    });
  }
  if (portAllocation === "fixed" && server.port === "auto") {
    throw new FizzySymphonyError("CONFIG_INVALID_SERVER_PORT", "server.port_allocation=fixed requires an explicit port.", {
      path: "server.port"
    });
  }
  if (portAllocation === "random" && server.port !== "auto") {
    throw new FizzySymphonyError("CONFIG_INVALID_SERVER_PORT", "server.port_allocation=random requires port=auto.", {
      path: "server.port"
    });
  }
}

function durationPaths() {
  return [
    "server.heartbeat_interval_ms",
    "polling.interval_ms",
    "agent.turn_timeout_ms",
    "agent.stall_timeout_ms",
    "agent.max_retry_backoff_ms",
    "runner.health.interval_ms",
    "runner.initialize_timeout_ms",
    "runner.request_timeout_ms",
    "runner.cancel_timeout_ms",
    "runner.stop_session_timeout_ms",
    "runner.terminate_timeout_ms",
    "runner.kill_timeout_ms",
    "runner.stream_timeout_ms",
    "claims.lease_ms",
    "claims.renew_interval_ms",
    "claims.steal_grace_ms",
    "claims.max_clock_skew_ms",
    "workpad.update_interval_ms",
    "safety.cleanup.retention_ms",
    "observability.status_retention_ms"
  ];
}

function getPath(object, path) {
  return path.split(".").reduce((value, part) => value?.[part], object);
}

function validateKnownKeys(value, shape, path = "") {
  if (shape === true || value === undefined || value === null) return;

  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return;
    for (const [index, item] of value.entries()) {
      validateKnownKeys(item, shape[0], `${path}.${index}`.replace(/^\./u, ""));
    }
    return;
  }

  if (shape.__map !== undefined) {
    if (!isPlainObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      validateKnownKeys(item, shape.__map, `${path}.${key}`.replace(/^\./u, ""));
    }
    return;
  }

  if (!isPlainObject(value)) return;

  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(shape, key)) {
      throw new FizzySymphonyError("CONFIG_UNKNOWN_KEY", `Unknown config key: ${pathFor(path, key)}`, {
        path: pathFor(path, key)
      });
    }
    validateKnownKeys(value[key], shape[key], pathFor(path, key));
  }
}

function resolveEnvironmentReferences(value, env, path = "") {
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveEnvironmentReferences(item, env, `${path}.${index}`));
  }

  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      value[key] = resolveEnvironmentReferences(child, env, pathFor(path, key));
    }
    return value;
  }

  if (typeof value === "string") {
    const match = value.match(/^\$([A-Z_][A-Z0-9_]*)$/u);
    if (match) {
      const variable = match[1];
      if (!Object.hasOwn(env, variable)) {
        if (isOptionalEnvironmentReference(path)) {
          return "";
        }
        throw new FizzySymphonyError("CONFIG_MISSING_ENV", `Missing environment variable ${variable}`, {
          variable,
          path,
          remediation: `Set ${variable} before running setup, validate, or daemon commands, or replace the config reference with an explicit non-secret value where appropriate.`
        });
      }
      return env[variable];
    }
  }

  return value;
}

function renderBoardEntries(boards, maxConcurrent, defaultModel = DEFAULT_CODEX_MODEL) {
  return boards.map((board) => [
    `    - id: ${yamlScalar(board.id)}`,
    `      label: ${yamlScalar(board.label ?? board.name ?? board.id)}`,
    "      enabled: true",
    "      routing_mode: column_scoped",
    "      defaults:",
    "        backend: codex",
    `        model: ${yamlScalar(defaultModel)}`,
    "        workspace: app",
    "        persona: repo-agent",
    "        unknown_managed_tag_policy: fail",
    "        allowed_card_overrides:",
    "          backend: false",
    "          model: false",
    "          workspace: false",
    "          persona: false",
    "          priority: true",
    "          completion: false",
    "        concurrency:",
    `          max_concurrent: ${maxConcurrent}`
  ].join("\n")).join("\n");
}

function renderCompactBoardEntries(boards, options = {}) {
  return boards.map((board) => [
    `    - id: ${yamlScalar(board.id)}`,
    `      label: ${yamlScalar(board.label ?? board.name ?? board.id)}`,
    "      defaults:",
    "        backend: codex",
    `        model: ${yamlScalar(options.defaultModel ?? "")}`,
    "        workspace: app",
    "        concurrency:",
    `          max_concurrent: ${options.maxConcurrent ?? 1}`
  ].join("\n")).join("\n");
}

function compactWebhookLines(webhook = {}, managedWebhookIdsByBoard = {}) {
  const managedIds = managedWebhookIdsByBoard ?? {};
  const includeWebhook = Object.hasOwn(webhook, "manage") ||
    Boolean(webhook.callback_url) ||
    Object.keys(managedIds).length > 0 ||
    Array.isArray(webhook.subscribed_actions);

  if (!includeWebhook) return [];

  const lines = [
    "",
    "webhook:",
    `  manage: ${Boolean(webhook.manage)}`
  ];

  if (webhook.callback_url) lines.push(`  callback_url: ${yamlScalar(webhook.callback_url)}`);
  if (webhook.secret_env) lines.push(`  secret: ${yamlScalar(`$${webhook.secret_env}`)}`);
  if (webhook.subscribed_actions?.length) {
    lines.push("  subscribed_actions:", renderStringList(webhook.subscribed_actions, 4));
  }
  if (Object.keys(managedIds).length > 0) {
    lines.push("  managed_webhook_ids_by_board:", renderStringMap(managedIds, 4));
  }

  return lines;
}

function renderStringMap(map, indent) {
  const padding = " ".repeat(indent);
  return Object.entries(map)
    .map(([key, value]) => `${padding}${yamlScalar(key)}: ${yamlScalar(value)}`)
    .join("\n");
}

function renderStringList(values, indent) {
  const padding = " ".repeat(indent);
  return values.map((value) => `${padding}- ${yamlScalar(value)}`).join("\n");
}

function isOptionalEnvironmentReference(path) {
  return path === "webhook.secret";
}

function resolveRelativePaths(config, configDir) {
  setPath(config, ["server", "registry_dir"], resolveFrom(configDir, config.server?.registry_dir));
  setPath(config, ["workspaces", "root"], resolveFrom(configDir, config.workspaces?.root));
  setPath(config, ["workspaces", "metadata_root"], resolveFrom(configDir, config.workspaces?.metadata_root));
  setPath(config, ["workspaces", "source_cache_root"], resolveFrom(configDir, config.workspaces?.source_cache_root));
  setPath(config, ["workspaces", "default_repo"], resolveFrom(configDir, config.workspaces?.default_repo));
  setPath(config, ["workflow", "fallback_path"], resolveFrom(configDir, config.workflow?.fallback_path));
  setPath(config, ["observability", "state_dir"], resolveFrom(configDir, config.observability?.state_dir));
  setPath(config, ["observability", "log_dir"], resolveFrom(configDir, config.observability?.log_dir));
  setPath(
    config,
    ["observability", "status_snapshot_path"],
    resolveFrom(configDir, config.observability?.status_snapshot_path)
  );

  const roots = config.safety?.allowed_roots;
  if (Array.isArray(roots)) {
    config.safety.allowed_roots = roots.map((root) => resolveFrom(configDir, root));
  }

  for (const workspace of Object.values(config.workspaces?.registry ?? {})) {
    workspace.repo = resolveFrom(configDir, workspace.repo);
    workspace.worktree_root = resolveFrom(configDir, workspace.worktree_root);
  }
}

function resolveFrom(base, value) {
  if (typeof value !== "string" || value === "") return value;
  return isAbsolute(value) ? value : resolve(base, value);
}

function relativePathForConfig(configDir, path) {
  const relativePath = relative(resolve(configDir), resolve(path));
  return relativePath === "" ? "." : relativePath;
}

function isValidPortValue(value) {
  return value === "auto" || isTcpPort(value);
}

function isTcpPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

function setPath(object, parts, value) {
  if (value === undefined) return;
  let target = object;
  for (const part of parts.slice(0, -1)) {
    if (!target?.[part]) return;
    target = target[part];
  }
  target[parts.at(-1)] = value;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function applyConfigDefaults(input = {}, options = {}) {
  const original = clone(input ?? {});
  const config = deepMerge(defaultConfig(options), original);
  const defaultModel = config.agent?.default_model ?? DEFAULT_CODEX_MODEL;

  const inputBoardEntries = Array.isArray(original.boards?.entries) ? original.boards.entries : [];
  config.boards.entries = inputBoardEntries.map((entry) => deepMerge(defaultBoardEntry(defaultModel), entry));

  const inputSources = isPlainObject(original.workspaces?.sources) ? original.workspaces.sources : {};
  config.workspaces.sources = Object.fromEntries(
    Object.entries(inputSources).map(([name, source]) => [
      name,
      deepMerge(defaultWorkspaceSourceEntry(source), source)
    ])
  );

  const defaultRepo = config.workspaces?.default_repo ?? ".";
  const inputRegistry = original.workspaces?.registry;
  const registryEntries = isPlainObject(inputRegistry) && Object.keys(inputRegistry).length > 0
    ? inputRegistry
    : { app: {} };
  config.workspaces.registry = Object.fromEntries(
    Object.entries(registryEntries).map(([name, workspace]) => [
      name,
      deepMerge(defaultWorkspaceEntry(defaultRepo, options, workspace), workspace)
    ])
  );
  if (config.workspaces.registry.app &&
    !original.workspaces?.registry?.app?.repo &&
    !original.workspaces?.registry?.app?.source) {
    config.workspaces.registry.app.repo = defaultRepo;
  }

  if (!Array.isArray(config.safety.ignored_dirty_paths)) {
    config.safety.ignored_dirty_paths = [...DEFAULT_SETUP_IGNORED_DIRTY_PATHS];
  }

  return config;
}

function defaultConfig(options = {}) {
  const local = (path) => defaultLocalPathForConfig(path, options.configDir);

  return {
    instance: { id: "auto", label: "auto" },
    fizzy: {
      token: "$FIZZY_API_TOKEN",
      account: "",
      api_url: DEFAULT_FIZZY_API_URL,
      bot_user_id: ""
    },
    boards: { entries: [] },
    server: {
      host: "127.0.0.1",
      port: "auto",
      port_allocation: "next_available",
      base_port: 4567,
      registry_dir: local(".fizzy-symphony/run/instances"),
      heartbeat_interval_ms: 5000
    },
    webhook: {
      enabled: true,
      path: "/webhook",
      secret: "$FIZZY_WEBHOOK_SECRET",
      max_event_age_seconds: 300,
      manage: false,
      managed_webhook_ids_by_board: {},
      callback_url: "",
      subscribed_actions: [
        "card_assigned",
        "card_closed",
        "card_postponed",
        "card_auto_postponed",
        "card_board_changed",
        "card_published",
        "card_reopened",
        "card_sent_back_to_triage",
        "card_triaged",
        "card_unassigned",
        "comment_created"
      ]
    },
    polling: {
      interval_ms: 30000,
      use_etags: true,
      use_api_filters: true,
      api_filters: {
        board_ids: [],
        column_ids: [],
        tag_ids: [],
        assignee_ids: [],
        assignment_status: "",
        indexed_by: "",
        sorted_by: "",
        terms: []
      }
    },
    agent: {
      max_concurrent: 1,
      max_concurrent_per_card: 1,
      turn_timeout_ms: 3600000,
      stall_timeout_ms: 300000,
      max_turns: 1,
      max_retry_backoff_ms: 300000,
      default_backend: "codex",
      default_model: DEFAULT_CODEX_MODEL,
      reasoning_effort: DEFAULT_CODEX_REASONING_EFFORT,
      default_persona: "repo-agent"
    },
    runner: {
      preferred: "cli_app_server",
      fallback: "cli_app_server",
      allow_fallback: true,
      sdk: { package: "", contract: "", smoke_test: false },
      cli_app_server: { command: "codex", args: ["app-server"] },
      initialize_timeout_ms: 10000,
      request_timeout_ms: 60000,
      cancel_timeout_ms: 10000,
      stop_session_timeout_ms: 10000,
      terminate_timeout_ms: 5000,
      kill_timeout_ms: 2000,
      stream_timeout_ms: 3600000,
      max_stderr_bytes: 65536,
      health: { enabled: true, interval_ms: 60000 },
      codex: {
        approval_policy: {
          mode: "reject",
          sandbox_approval: "reject",
          command_approval: "reject",
          tool_approval: "reject",
          mcp_elicitation: "reject"
        },
        interactive: false,
        thread_sandbox: "workspace-write",
        turn_sandbox_policy: { type: "workspaceWrite" }
      }
    },
    workspaces: {
      root: local(".fizzy-symphony/workspaces"),
      metadata_root: local(".fizzy-symphony/run/workspaces"),
      default_isolation: "git_worktree",
      source_cache_root: local(".fizzy-symphony/sources"),
      default_repo: ".",
      sources: {},
      registry: {},
      retry: { workspace_policy: "reuse" }
    },
    workflow: {
      create_starter_on_setup: false,
      fallback_enabled: false,
      fallback_path: ""
    },
    routing: {
      allow_postponed_cards: false,
      rerun: {
        mode: "explicit_tag_only",
        agent_rerun_consumption: "remove_when_supported"
      }
    },
    diagnostics: { no_dispatch: false },
    claims: {
      mode: "structured_comment",
      tag_visibility: false,
      tag: "agent-claimed",
      assign_on_claim: false,
      watch_on_claim: false,
      lease_ms: 900000,
      renew_interval_ms: 300000,
      steal_grace_ms: 30000,
      max_clock_skew_ms: 30000
    },
    completion: {
      allow_card_completion_override: false,
      markers: {
        mode: "structured_comment_and_tag",
        success_tag_prefix: "agent-completed",
        failure_tag_prefix: "agent-completion-failed"
      }
    },
    workpad: {
      enabled: true,
      mode: "single_comment",
      update_interval_ms: 30000
    },
    safety: {
      allowed_roots: defaultAllowedRootsForConfig(options.configDir),
      ignored_dirty_paths: [...DEFAULT_SETUP_IGNORED_DIRTY_PATHS],
      dirty_source_repo_policy: "fail",
      cleanup: {
        policy: "preserve",
        require_proof_before_cleanup: true,
        require_handoff_before_cleanup: true,
        forbid_force_remove: true,
        retention_ms: 604800000
      }
    },
    observability: {
      state_dir: local(".fizzy-symphony/run"),
      log_dir: local(".fizzy-symphony/logs"),
      status_snapshot_path: local(".fizzy-symphony/run/status/latest.json"),
      status_retention_ms: 604800000,
      log_format: "json"
    }
  };
}

function defaultBoardEntry(defaultModel = DEFAULT_CODEX_MODEL) {
  return {
    id: "",
    label: "",
    enabled: true,
    routing_mode: "column_scoped",
    defaults: {
      backend: "codex",
      model: defaultModel,
      workspace: "app",
      persona: "repo-agent",
      unknown_managed_tag_policy: "fail",
      allowed_card_overrides: {
        backend: false,
        model: false,
        workspace: false,
        persona: false,
        priority: true,
        completion: false
      },
      concurrency: { max_concurrent: 1 }
    }
  };
}

function defaultWorkspaceEntry(defaultRepo = ".", options = {}, workspace = {}) {
  return omitUndefined({
    repo: workspace?.source ? undefined : defaultRepo,
    isolation: "git_worktree",
    base_ref: "HEAD",
    worktree_root: defaultLocalPathForConfig(".fizzy-symphony/worktrees", options.configDir),
    branch_prefix: "fizzy",
    workflow_path: "WORKFLOW.md",
    require_clean_source: true
  });
}

function defaultWorkspaceSourceEntry(source = {}) {
  if (source?.type === "git_remote" || source?.remote_url) {
    return {
      type: "git_remote",
      remote_url: "",
      base_ref: "main",
      fetch_depth: 0,
      auth: "auto"
    };
  }
  return {};
}

function defaultLocalPathForConfig(path, configDir) {
  if (typeof configDir === "string" && basename(resolve(configDir)) === ".fizzy-symphony") {
    return path.replace(/^\.fizzy-symphony\//u, "");
  }
  return path;
}

function defaultAllowedRootsForConfig(configDir) {
  if (typeof configDir === "string" && basename(resolve(configDir)) === ".fizzy-symphony") {
    return ["..", "."];
  }
  return [".", ".fizzy-symphony"];
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override ?? base);
  const merged = clone(base);
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = clone(value);
    }
  }
  return merged;
}

function yamlScalar(value) {
  if (value === "") return "\"\"";
  if (typeof value === "boolean") return String(value);
  if (/^[A-Za-z0-9_.:/@ -]+$/u.test(String(value))) return String(value);
  return JSON.stringify(String(value));
}

function pathFor(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function parseGeneratedYaml(text, sourcePath) {
  const lines = yamlLogicalLines(text, sourcePath);
  if (lines.length === 0) return {};
  const [value, nextIndex] = parseYamlNode(lines, 0, lines[0].indent, sourcePath);
  if (nextIndex !== lines.length) {
    throw new FizzySymphonyError("CONFIG_PARSE_ERROR", "Unexpected trailing YAML content.", {
      path: sourcePath,
      line: lines[nextIndex]?.number
    });
  }
  return value;
}

function yamlLogicalLines(text, sourcePath) {
  return text.split(/\r?\n/u).flatMap((raw, index) => {
    if (/^\t/u.test(raw)) {
      throw new FizzySymphonyError("CONFIG_PARSE_ERROR", "Tabs are not supported in config YAML indentation.", {
        path: sourcePath,
        line: index + 1
      });
    }

    const content = raw.trim();
    if (!content || content.startsWith("#")) return [];

    const indent = raw.match(/^ */u)[0].length;
    return [{ indent, content, number: index + 1 }];
  });
}

function parseYamlNode(lines, index, indent, sourcePath) {
  if (lines[index]?.content.startsWith("- ")) {
    return parseYamlArray(lines, index, indent, sourcePath);
  }
  return parseYamlObject(lines, index, indent, sourcePath);
}

function parseYamlObject(lines, index, indent, sourcePath) {
  const object = {};
  let cursor = index;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent < indent || line.content.startsWith("- ")) break;
    if (line.indent > indent) {
      throw new FizzySymphonyError("CONFIG_PARSE_ERROR", "Unexpected nested YAML mapping.", {
        path: sourcePath,
        line: line.number
      });
    }

    const [key, rest] = splitYamlPair(line, sourcePath);
    if (rest === "") {
      const next = lines[cursor + 1];
      if (!next || next.indent <= indent) {
        object[key] = {};
        cursor += 1;
      } else {
        const [child, nextIndex] = parseYamlNode(lines, cursor + 1, next.indent, sourcePath);
        object[key] = child;
        cursor = nextIndex;
      }
    } else {
      object[key] = parseYamlScalar(rest);
      cursor += 1;
    }
  }

  return [object, cursor];
}

function parseYamlArray(lines, index, indent, sourcePath) {
  const array = [];
  let cursor = index;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent < indent) break;
    if (line.indent !== indent || !line.content.startsWith("- ")) break;

    const item = line.content.slice(2).trim();
    if (item === "") {
      const next = lines[cursor + 1];
      if (!next || next.indent <= indent) {
        array.push(null);
        cursor += 1;
      } else {
        const [child, nextIndex] = parseYamlNode(lines, cursor + 1, next.indent, sourcePath);
        array.push(child);
        cursor = nextIndex;
      }
      continue;
    }

    if (item.includes(":")) {
      const [key, rest] = splitYamlPair({ ...line, content: item }, sourcePath);
      const object = {};
      object[key] = rest === "" ? {} : parseYamlScalar(rest);
      cursor += 1;

      const next = lines[cursor];
      if (next && next.indent > indent) {
        const [child, nextIndex] = parseYamlObject(lines, cursor, next.indent, sourcePath);
        Object.assign(object, child);
        cursor = nextIndex;
      }

      array.push(object);
    } else {
      array.push(parseYamlScalar(item));
      cursor += 1;
    }
  }

  return [array, cursor];
}

function splitYamlPair(line, sourcePath) {
  const match = line.content.match(/^([^:]+):(.*)$/u);
  if (!match) {
    throw new FizzySymphonyError("CONFIG_PARSE_ERROR", "Expected YAML key/value pair.", {
      path: sourcePath,
      line: line.number,
      content: line.content
    });
  }
  return [match[1].trim(), match[2].trim()];
}

function parseYamlScalar(value) {
  if (value === "{}") return {};
  if (value === "[]") return [];
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/u.test(value)) return Number(value);
  if (/^".*"$/u.test(value)) return JSON.parse(value);
  if (/^'.*'$/u.test(value)) return value.slice(1, -1).replace(/''/gu, "'");
  return value;
}

function isFizzySymphonyError(error) {
  return error instanceof FizzySymphonyError;
}
