import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

import { FizzySymphonyError, issue } from "./errors.js";

const AGENT_INSTRUCTIONS = "agent-instructions";
const AGENT_BOARD = "agent-board";
const SUPPORTED_SDK_RUNNERS = [];

const defaultAllowedCardOverrides = {
  backend: false,
  model: false,
  workspace: false,
  persona: false,
  priority: true,
  completion: false
};

export function normalizeTag(tag) {
  const raw = typeof tag === "string" ? tag : tag?.name ?? tag?.slug ?? tag?.label ?? "";
  return raw.trim().replace(/^#+/u, "").toLowerCase();
}

export function resolveManagedTags(tags, options = {}) {
  const byName = new Map();
  for (const tag of tags ?? []) {
    const normalized = normalizeTag(tag);
    if (!normalized) continue;
    byName.set(normalized, { id: tag.id ?? tag.tag_id ?? normalized, name: normalized, source: tag });
  }

  const resolved = {};
  const namesToResolve = new Set([...Object.keys(managedTagFamilies()), ...(options.required ?? []).map(normalizeTag)]);
  for (const name of namesToResolve) {
    if (byName.has(name)) {
      const tag = byName.get(name);
      resolved[name] = { id: tag.id, name: tag.name };
    }
  }

  const missing = (options.required ?? []).map(normalizeTag).filter((name) => !resolved[name]);
  if (missing.length > 0) {
    throw new FizzySymphonyError("MANAGED_TAG_NOT_FOUND", "Required managed Fizzy tags could not be resolved.", {
      missing
    });
  }

  return resolved;
}

export function managedTagsUsedByBoards(boards) {
  const used = new Set();
  for (const board of boards ?? []) {
    for (const card of board.cards ?? []) {
      for (const tag of normalizedTags(card)) {
        if (isManagedRouteTag(tag)) used.add(tag);
      }
    }
  }
  return [...used].sort();
}

export function isSupportedSdkRunner(sdk = {}) {
  return SUPPORTED_SDK_RUNNERS.some((supported) => {
    return supported.package === sdk.package && supported.contract === sdk.contract;
  });
}

export function discoverGoldenTicketRoutes(boards, options = {}) {
  const routes = [];

  for (const board of boards) {
    const boardOptions = optionsForBoard(options, board.id);
    const cards = board.cards ?? [];
    const agentInstructionCards = cards.filter((card) => hasTag(card, AGENT_INSTRUCTIONS));

    for (const card of agentInstructionCards) {
      if (!card.golden) {
        throw new FizzySymphonyError(
          "TAG_ONLY_INSTRUCTION_CARD",
          "Cards tagged agent-instructions must also be native golden cards.",
          { board_id: board.id, card_id: card.id }
        );
      }
    }

    const routeCards = cards.filter((card) => card.golden && hasTag(card, AGENT_INSTRUCTIONS));
    const routesByColumn = new Map();

    for (const card of routeCards) {
      const sourceColumnId = getColumnId(card);
      if (!sourceColumnId || hasTag(card, AGENT_BOARD)) {
        throw new FizzySymphonyError(
          "BOARD_LEVEL_GOLDEN_TICKET",
          "Board-level golden tickets are not supported in the MVP.",
          { board_id: board.id, card_id: card.id }
        );
      }

      const existing = routesByColumn.get(sourceColumnId);
      if (existing) {
        throw new FizzySymphonyError(
          "DUPLICATE_GOLDEN_TICKETS",
          "Only one agent-instructions golden ticket is allowed per source column.",
          { board_id: board.id, column_id: sourceColumnId, card_ids: [existing.card.id, card.id] }
        );
      }

      const route = parseGoldenTicketRoute(board, card, boardOptions);
      routesByColumn.set(sourceColumnId, { card, route });
      routes.push(route);
    }
  }

  validateCompletionGraph(routes);
  return routes;
}

export function parseGoldenTicketRoute(board, card, options = {}) {
  const tags = normalizedTags(card);
  const sourceColumnId = getColumnId(card);
  const sourceColumn = findColumn(board, sourceColumnId);

  const backend = parseSingleFamily(tags, "backend", (tag) => {
    if (tag === "codex" || tag === "backend-codex") return "codex";
    if (tag.startsWith("backend-")) {
      throw new FizzySymphonyError("INVALID_BACKEND_TAG", "Only Codex backend tags are valid for MVP routes.", {
        board_id: board.id,
        card_id: card.id,
        tag
      });
    }
    return null;
  }) ?? options.defaults?.backend ?? "codex";

  const model = parseSingleFamily(tags, "model", (tag) => tagValue(tag, "model-")) ?? options.defaults?.model ?? "";
  const workspace = parseSingleFamily(tags, "workspace", (tag) => tagValue(tag, "workspace-")) ?? options.defaults?.workspace ?? "app";
  const persona = parseSingleFamily(tags, "persona", (tag) => tagValue(tag, "persona-")) ?? options.defaults?.persona ?? "repo-agent";
  const priority = parseSingleFamily(tags, "priority", (tag) => {
    const value = tagValue(tag, "priority-");
    if (!value) return null;
    return /^[1-5]$/u.test(value) ? Number(value) : invalidTag("INVALID_PRIORITY_TAG", tag, board, card);
  });
  const completion = parseCompletion(tags, board, sourceColumnId, card);

  rejectUnknownManagedTags(tags, board, card, options);

  const id = `board:${board.id}:column:${sourceColumnId}:golden:${card.id}`;
  const route = {
    id,
    board_id: board.id,
    source_column_id: sourceColumnId,
    source_column_name: sourceColumn?.name ?? sourceColumnId,
    golden_card_id: card.id,
    backend,
    model,
    workspace,
    persona,
    priority,
    completion,
    allowed_card_overrides: options.allowed_card_overrides ?? defaultAllowedCardOverrides,
    rerun_policy: options.rerun_policy ?? { mode: "explicit_tag_only" }
  };

  route.fingerprint = digest({
    route_id: route.id,
    golden_card_digest: digest({
      id: card.id,
      title: card.title ?? "",
      column_id: sourceColumnId,
      golden: Boolean(card.golden),
      tags
    }),
    backend: route.backend,
    model: route.model,
    workspace: route.workspace,
    persona: route.persona,
    completion: route.completion,
    allowed_card_overrides: route.allowed_card_overrides,
    rerun_policy: route.rerun_policy
  });

  return route;
}

export async function validateStartup({ config, fizzy, runner }) {
  const errors = [];
  const warnings = [];
  const routes = [];
  let runnerHealth = { status: "unknown", kind: config.runner?.preferred ?? "unknown" };

  validateLocalConfig(config, errors);

  let identityValid = false;
  try {
    await fizzy?.getIdentity?.();
    identityValid = true;
  } catch (error) {
    errors.push(issue("FIZZY_IDENTITY_INVALID", "Fizzy identity validation failed.", { cause: error.message }));
  }

  let users = [];
  let resolvedTags = {};
  try {
    users = await fizzy?.listUsers?.(config.fizzy?.account) ?? [];
  } catch (error) {
    errors.push(issue("FIZZY_USERS_UNAVAILABLE", "Unable to list Fizzy users.", { cause: error.message }));
  }

  if (identityValid) {
    let tags = [];
    try {
      tags = await fizzy?.listTags?.(config.fizzy?.account) ?? [];
    } catch (error) {
      errors.push(issue(error.code ?? "FIZZY_TAGS_UNAVAILABLE", error.message, error.details ?? {}));
    }

    try {
      const entropy = await fizzy?.getEntropy?.(
        config.fizzy?.account,
        enabledBoardEntries(config).map((entry) => entry.id)
      );
      for (const warning of entropy?.warnings ?? []) {
        warnings.push(issue(warning.code ?? "ENTROPY_WARNING", warning.message ?? "Fizzy entropy warning.", warning));
      }
    } catch {
      warnings.push(issue("ENTROPY_UNKNOWN", "Fizzy entropy settings were not visible during validation."));
    }

    const boards = [];
    for (const entry of enabledBoardEntries(config)) {
      try {
        boards.push(await fizzy?.getBoard?.(entry.id));
      } catch (error) {
        errors.push(issue("BOARD_UNAVAILABLE", "Configured board is not accessible.", {
          board_id: entry.id,
          cause: error.message
        }));
      }
    }

    try {
      routes.push(...discoverGoldenTicketRoutes(boards.filter(Boolean), routeOptionsFromConfig(config)));
    } catch (error) {
      errors.push(issue(error.code ?? "GOLDEN_TICKET_VALIDATION_FAILED", error.message, error.details ?? {}));
    }

    try {
      resolvedTags = resolveManagedTags(tags, {
        required: ["agent-instructions", ...managedTagsUsedByBoards(boards.filter(Boolean))]
      });
    } catch (error) {
      errors.push(issue(error.code ?? "FIZZY_TAGS_UNAVAILABLE", error.message, error.details ?? {}));
    }
  }

  if ((config.claims?.assign_on_claim || config.claims?.watch_on_claim) && config.fizzy?.bot_user_id) {
    if (!users.some((user) => user.id === config.fizzy.bot_user_id)) {
      errors.push(issue("INVALID_BOT_USER", "Configured bot_user_id is not present in account users.", {
        bot_user_id: config.fizzy.bot_user_id
      }));
    }
  }

  validateManagedWebhook(config, errors, warnings);

  await validateWorkspaceRoots(config, errors);
  await validateWorkflowFiles(config, errors);

  try {
    runnerHealth = await validateRunner(config, runner);
    if (runnerHealth.status !== "ready" && !config.diagnostics?.no_dispatch) {
      errors.push(issue("RUNNER_UNAVAILABLE", "Configured Codex runner is not ready.", runnerHealth));
    }
  } catch (error) {
    runnerHealth = { status: "unavailable", kind: config.runner?.preferred ?? "unknown", error: error.message };
    errors.push(issue(error.code ?? "RUNNER_INVALID", error.message, error.details ?? {}));
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    routes,
    resolvedTags,
    runnerHealth
  };
}

export function createCompletionFailureMarker({ run, route, instance, workspace, card, failure_reason, reason, result_comment_id, proof }) {
  const payload = omitUndefined({
    marker: "fizzy-symphony:completion-failed:v1",
    kind: "completion_failed",
    run_id: run?.id,
    route_id: route.id,
    route_fingerprint: route.fingerprint,
    instance_id: instance?.id,
    workspace_key: workspace?.key,
    failure_reason: failure_reason ?? reason,
    result_comment_id,
    proof_file: proof?.file,
    proof_digest: proof?.digest,
    card_digest: card?.digest,
    created_at: new Date().toISOString()
  });

  return {
    tag: `agent-completion-failed-${shortRouteId(route.id)}`,
    body: [
      "<!-- fizzy-symphony-marker -->",
      "fizzy-symphony:completion-failed:v1",
      "",
      "```json",
      canonicalJson(payload),
      "```"
    ].join("\n")
  };
}

export function parseCompletionFailureMarker(body) {
  const match = String(body).match(
    /<!-- fizzy-symphony-marker -->\s*fizzy-symphony:completion-failed:v1\s*```json\s*([\s\S]*?)\s*```/u
  );
  if (!match) {
    throw new FizzySymphonyError(
      "MALFORMED_COMPLETION_FAILURE_MARKER",
      "Completion failure marker Markdown block was not found."
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    throw new FizzySymphonyError("MALFORMED_COMPLETION_FAILURE_MARKER", "Completion failure marker is not valid JSON.", {
      cause: error.message
    });
  }

  const required = [
    "marker",
    "kind",
    "run_id",
    "route_id",
    "route_fingerprint",
    "instance_id",
    "workspace_key",
    "failure_reason",
    "card_digest"
  ];
  const missing = required.filter((field) => !parsed?.[field]);
  if (
    parsed?.marker !== "fizzy-symphony:completion-failed:v1" ||
    parsed?.kind !== "completion_failed" ||
    missing.length > 0
  ) {
    throw new FizzySymphonyError(
      "MALFORMED_COMPLETION_FAILURE_MARKER",
      "Completion failure marker is missing required fields.",
      { marker: parsed?.marker, missing }
    );
  }

  return parsed;
}

function validateLocalConfig(config, errors) {
  if (!config.fizzy?.token) {
    errors.push(issue("CONFIG_MISSING_SECRET", "fizzy.token must resolve to a non-empty value.", { path: "fizzy.token" }));
  }

  if (!validPort(config.server?.port) || !validPort(config.server?.base_port)) {
    errors.push(issue("INVALID_SERVER_PORT", "server.port and server.base_port must be valid TCP ports or auto.", {
      port: config.server?.port,
      base_port: config.server?.base_port
    }));
  }

  if (config.claims?.mode !== "structured_comment") {
    errors.push(issue("INVALID_CLAIM_MODE", "Task 1 supports claims.mode=structured_comment only.", {
      mode: config.claims?.mode
    }));
  }

  const cleanup = config.safety?.cleanup ?? {};
  if (
    cleanup.policy !== "preserve" &&
    (cleanup.require_proof_before_cleanup !== true ||
      cleanup.require_handoff_before_cleanup !== true ||
      cleanup.forbid_force_remove !== true)
  ) {
    errors.push(issue("UNSAFE_CLEANUP_POLICY", "Non-preserve cleanup requires proof, handoff, and no force removal.", cleanup));
  }
}

function validateManagedWebhook(config, errors, warnings) {
  if (!config.webhook?.manage) return;
  const callback = config.webhook.callback_url ?? "";
  const secret = config.webhook.secret ?? "";
  let validUrl = false;

  try {
    const url = new URL(callback);
    validUrl =
      url.protocol === "https:" &&
      !["127.0.0.1", "localhost", "::1"].includes(url.hostname) &&
      url.hostname !== "";
  } catch {
    validUrl = false;
  }

  if (!validUrl) {
    errors.push(issue("MANAGED_WEBHOOK_MISCONFIGURED", "Managed webhooks require a public HTTPS callback_url.", {
      callback_url: callback,
      has_secret: Boolean(secret)
    }));
  }

  if (validUrl && !secret) {
    warnings.push(issue(
      "WEBHOOK_SECRET_NOT_CONFIGURED",
      "Managed webhook setup has no signing secret; webhook signature verification will be disabled.",
      { callback_url: callback }
    ));
  }
}

async function validateWorkspaceRoots(config, errors) {
  const allowedRoots = (config.safety?.allowed_roots ?? []).filter(Boolean).map((root) => resolve(root));
  const registry = config.workspaces?.registry ?? {};

  if (allowedRoots.length > 0) {
    const paths = [
      ["workspaces.root", config.workspaces?.root],
      ["workspaces.metadata_root", config.workspaces?.metadata_root],
      ...Object.entries(registry).flatMap(([name, workspace]) => [
        [`workspaces.registry.${name}.repo`, workspace.repo],
        [`workspaces.registry.${name}.worktree_root`, workspace.worktree_root]
      ])
    ];

    for (const [path, value] of paths) {
      if (value && !isInsideAnyRoot(value, allowedRoots)) {
        errors.push(issue("UNSAFE_WORKSPACE_ROOT", "Configured workspace path is outside safety.allowed_roots.", {
          path,
          value,
          allowed_roots: allowedRoots
        }));
      }
    }
  }

  for (const [name, workspace] of Object.entries(registry)) {
    if (!workspace.repo) continue;
    try {
      await access(workspace.repo);
    } catch {
      errors.push(issue("SOURCE_REPO_UNAVAILABLE", "Configured source repository is not accessible.", {
        workspace: name,
        repo: workspace.repo
      }));
    }
  }
}

async function validateWorkflowFiles(config, errors) {
  if (config.workflow?.fallback_enabled) return;

  for (const [name, workspace] of Object.entries(config.workspaces?.registry ?? {})) {
    const workflowPath = join(workspace.repo, workspace.workflow_path || "WORKFLOW.md");
    try {
      await access(workflowPath);
    } catch {
      errors.push(issue("MISSING_WORKFLOW", "Configured workspace repository is missing WORKFLOW.md.", {
        workspace: name,
        path: workflowPath
      }));
    }
  }
}

async function validateRunner(config, runner) {
  const runnerConfig = resolveRunnerConfig(config.runner ?? {});

  if (!["sdk", "cli_app_server"].includes(runnerConfig.preferred)) {
    throw new FizzySymphonyError("INVALID_RUNNER", "runner.preferred must be sdk or cli_app_server.", {
      preferred: runnerConfig.preferred
    });
  }

  if (!["cli_app_server", "none"].includes(runnerConfig.fallback)) {
    throw new FizzySymphonyError("INVALID_RUNNER", "runner.fallback must be cli_app_server or none.", {
      fallback: runnerConfig.fallback
    });
  }

  if (runnerConfig.preferred === "cli_app_server" && !runnerConfig.cli_app_server?.command) {
    throw new FizzySymphonyError("INVALID_RUNNER", "runner.cli_app_server.command is required.", {
      path: "runner.cli_app_server.command"
    });
  }

  if (runner?.detect) {
    let detected;
    try {
      detected = await runner.detect(runnerConfig);
    } catch (error) {
      throw new FizzySymphonyError("RUNNER_DETECT_FAILED", "Runner detection failed.", {
        cause: error.message
      });
    }
    if (detected?.available === false) {
      throw new FizzySymphonyError("RUNNER_DETECT_FAILED", "Runner detection failed.", detected);
    }
  }

  if (runner?.validate) {
    const validation = await runner.validate(runnerConfig, null);
    if (validation?.ok === false) {
      throw new FizzySymphonyError("INVALID_RUNNER", "Runner contract validation failed.", validation);
    }
  }

  if (runner?.health) {
    return runner.health(runnerConfig);
  }

  return { status: "unavailable", kind: runnerConfig.preferred, reason: "No runner dependency was injected." };
}

function resolveRunnerConfig(runnerConfig) {
  if (runnerConfig.preferred !== "sdk") return runnerConfig;

  if (!runnerConfig.sdk?.package || !runnerConfig.sdk?.contract) {
    throw new FizzySymphonyError("INVALID_RUNNER", "SDK runner requires an exact package and contract.", {
      package: runnerConfig.sdk?.package ?? "",
      contract: runnerConfig.sdk?.contract ?? ""
    });
  }

  if (isSupportedSdkRunner(runnerConfig.sdk)) return runnerConfig;

  if (runnerConfig.allow_fallback && runnerConfig.fallback === "cli_app_server") {
    return {
      ...runnerConfig,
      preferred: "cli_app_server",
      effective_from: "sdk",
      unsupported_sdk: runnerConfig.sdk
    };
  }

  throw new FizzySymphonyError("INVALID_RUNNER", "SDK runner package and contract are not selected for Task 1.", {
    package: runnerConfig.sdk.package,
    contract: runnerConfig.sdk.contract
  });
}

function parseCompletion(tags, board, sourceColumnId, card) {
  const completionTags = [];
  let noRepeat = false;

  for (const tag of tags) {
    if (tag.startsWith("move-to-")) completionTags.push({ tag, policy: "move_to_column" });
    if (tag === "close-on-complete") completionTags.push({ tag, policy: "close" });
    if (tag === "comment-once") completionTags.push({ tag, policy: "comment_once" });
    if (tag === "no-repeat") noRepeat = true;
  }

  if (completionTags.length > 1) {
    throw new FizzySymphonyError("CONFLICTING_COMPLETION_TAGS", "Golden ticket has conflicting completion tags.", {
      board_id: board.id,
      card_id: card.id,
      tags: completionTags.map((entry) => entry.tag)
    });
  }

  if (completionTags.length === 0) {
    throw new FizzySymphonyError("MISSING_COMPLETION_POLICY", "Golden ticket routes require an explicit completion policy.", {
      board_id: board.id,
      card_id: card.id
    });
  }

  if (noRepeat && completionTags[0].policy !== "comment_once") {
    throw new FizzySymphonyError("CONFLICTING_COMPLETION_TAGS", "no-repeat is valid only with comment-once.", {
      board_id: board.id,
      card_id: card.id
    });
  }

  const selected = completionTags[0];
  if (selected.policy === "move_to_column") {
    const slug = selected.tag.slice("move-to-".length);
    if (!slug) {
      throw new FizzySymphonyError("MISSING_COMPLETION_TARGET", "move-to completion tags require a target column.", {
        board_id: board.id,
        card_id: card.id
      });
    }
    const target = findColumnByCompletionSlug(board, slug);
    if (!target) {
      throw new FizzySymphonyError("MISSING_COMPLETION_TARGET", "move-to completion target column does not exist.", {
        board_id: board.id,
        card_id: card.id,
        tag: selected.tag
      });
    }
    if (target.id === sourceColumnId) {
      throw new FizzySymphonyError("COMPLETION_SAME_COLUMN", "Routes cannot move completed cards to their source column.", {
        board_id: board.id,
        card_id: card.id,
        column_id: sourceColumnId
      });
    }
    return { policy: "move_to_column", target_column_id: target.id, target_column_name: target.name };
  }

  return { policy: selected.policy };
}

function findColumnByCompletionSlug(board, slug) {
  const matches = (board.columns ?? []).filter((column) => completionSlug(column.name) === slug);
  if (matches.length > 1) {
    throw new FizzySymphonyError("DUPLICATE_COMPLETION_COLUMN_SLUG", "Completion target slug matches multiple columns.", {
      board_id: board.id,
      slug,
      column_ids: matches.map((column) => column.id)
    });
  }
  return matches[0] ?? null;
}

function validateCompletionGraph(routes) {
  const moveTargetBySource = new Map();
  const routedSources = new Set(routes.map((route) => routeColumnKey(route.board_id, route.source_column_id)));

  for (const route of routes) {
    const targetKey = routeColumnKey(route.board_id, route.completion.target_column_id);
    if (route.completion.policy === "move_to_column" && routedSources.has(targetKey)) {
      moveTargetBySource.set(routeColumnKey(route.board_id, route.source_column_id), targetKey);
    }
  }

  for (const source of moveTargetBySource.keys()) {
    const seen = new Set();
    let current = source;
    while (moveTargetBySource.has(current)) {
      current = moveTargetBySource.get(current);
      if (current === source || seen.has(current)) {
        const [boardId, columnId] = source.split(":", 2);
        throw new FizzySymphonyError("COMPLETION_CYCLE", "move-to completion policies form an unsafe route cycle.", {
          board_id: boardId,
          column_id: columnId
        });
      }
      seen.add(current);
    }
  }
}

function parseSingleFamily(tags, family, parser) {
  const values = new Map();
  for (const tag of tags) {
    const value = parser(tag);
    if (value !== null && value !== undefined) {
      values.set(value, [...(values.get(value) ?? []), tag]);
    }
  }

  if (values.size > 1) {
    throw new FizzySymphonyError(`CONFLICTING_${family.toUpperCase()}_TAGS`, `Golden ticket has conflicting ${family} tags.`, {
      values: [...values.keys()]
    });
  }

  return values.keys().next().value;
}

function rejectUnknownManagedTags(tags, board, card, options) {
  const unknown = tags.filter((tag) => {
    if (tag === AGENT_INSTRUCTIONS || tag === AGENT_BOARD || tag === "agent-rerun") return false;
    if (tag === "codex" || tag === "backend-codex") return false;
    if (tag === "close-on-complete" || tag === "comment-once" || tag === "no-repeat") return false;
    if (/^(model|workspace|persona)-[^-].*/u.test(tag)) return false;
    if (/^priority-[1-5]$/u.test(tag)) return false;
    if (/^move-to-.+/u.test(tag)) return false;
    if (/^backend-.+/u.test(tag)) return false;
    if (tag.startsWith("agent-")) return true;
    return false;
  });

  if (unknown.length > 0 && options.unknownManagedTagPolicy !== "warn") {
    throw new FizzySymphonyError("UNKNOWN_MANAGED_TAG", "Golden ticket contains unknown managed agent tags.", {
      board_id: board.id,
      card_id: card.id,
      tags: unknown
    });
  }
}

function managedTagFamilies() {
  return {
    "agent-instructions": "scope",
    "backend-codex": "backend",
    codex: "backend",
    "close-on-complete": "completion",
    "comment-once": "completion",
    "no-repeat": "completion"
  };
}

function isManagedRouteTag(tag) {
  if (Object.hasOwn(managedTagFamilies(), tag)) return true;
  if (tag.startsWith("move-to-")) return true;
  if (tag.startsWith("model-")) return true;
  if (tag.startsWith("workspace-")) return true;
  if (tag.startsWith("persona-")) return true;
  if (/^priority-[1-5]$/u.test(tag)) return true;
  if (tag.startsWith("backend-")) return true;
  return tag === "agent-board" || tag === "agent-rerun";
}

function routeOptionsFromConfig(config) {
  const byBoardId = Object.fromEntries(enabledBoardEntries(config).map((board) => [board.id, routeOptionsFromBoardEntry(board, config)]));
  const firstBoard = enabledBoardEntries(config)[0];
  return {
    ...routeOptionsFromBoardEntry(firstBoard, config),
    byBoardId
  };
}

function routeOptionsFromBoardEntry(board, config) {
  return {
    defaults: board?.defaults,
    allowed_card_overrides: board?.defaults?.allowed_card_overrides ?? defaultAllowedCardOverrides,
    unknownManagedTagPolicy: board?.defaults?.unknown_managed_tag_policy,
    rerun_policy: config.routing?.rerun
  };
}

function optionsForBoard(options, boardId) {
  return options.byBoardId?.[boardId] ?? options;
}

function routeColumnKey(boardId, columnId) {
  return `${boardId}:${columnId}`;
}

function enabledBoardEntries(config) {
  return (config.boards?.entries ?? []).filter((entry) => entry.enabled !== false);
}

function validPort(port) {
  if (port === "auto") return true;
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function isInsideAnyRoot(path, allowedRoots) {
  const resolvedPath = resolve(path);
  return allowedRoots.some((root) => {
    const relativePath = relative(root, resolvedPath);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
}

function normalizedTags(card) {
  return [...new Set((card.tags ?? []).map(normalizeTag).filter(Boolean))];
}

function hasTag(card, tag) {
  return normalizedTags(card).includes(tag);
}

function getColumnId(card) {
  return card.column_id ?? card.column?.id ?? null;
}

function findColumn(board, columnId) {
  return (board.columns ?? []).find((column) => column.id === columnId) ?? null;
}

function tagValue(tag, prefix) {
  return tag.startsWith(prefix) && tag.length > prefix.length ? tag.slice(prefix.length) : null;
}

function invalidTag(code, tag, board, card) {
  throw new FizzySymphonyError(code, `Invalid managed tag: ${tag}`, {
    board_id: board.id,
    card_id: card.id,
    tag
  });
}

function completionSlug(name) {
  return String(name).trim().toLowerCase().replace(/[\s-]+/gu, "-");
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function shortRouteId(routeId) {
  return createHash("sha256").update(String(routeId)).digest("hex").slice(0, 12);
}

function omitUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
