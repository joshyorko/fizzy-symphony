import { redactGitRemoteUrl } from "./git-source-cache.js";

const RESET = "\x1b[0m";
const COLORS = {
  dim: "38;2;100;116;139",
  primary: "1;38;2;96;165;250",
  success: "1;38;2;34;197;94",
  warning: "1;38;2;250;204;21",
  error: "1;38;2;248;113;113",
  accent: "1;38;2;244;114;182"
};

export function formatSetupMutationReview(plan = {}, options = {}) {
  const lines = [
    "Review setup changes",
    "",
    ...setupMutationLines(plan).map((line) => `  ${options.icons === false ? "-" : "✓"} ${line}`),
    "",
    "Apply these changes?"
  ];

  if (options.includeInstruction !== false) {
    lines.push("  Press Enter to apply, or type no to keep the repo untouched.");
  }

  return lines.join("\n");
}

export function setupMutationLines(plan = {}) {
  const lines = [];
  if (plan.workflow?.action === "create") lines.push(`Create WORKFLOW.md at ${plan.workflow.path}`);
  if (plan.workflow?.action === "append") lines.push(`Append a fizzy-symphony section to ${plan.workflow.path}`);
  if (plan.setup_mode === "create_starter") {
    lines.push(`Create starter board "${plan.starter_board_name}" with limited access`);
    lines.push("Create route Ready for Agents -> Ready To Ship");
  }
  if (plan.webhook?.manage) lines.push(`Manage webhooks for ${reviewBoardCount(plan)} board(s): ${plan.webhook.callback_url || "configured callback"}`);
  lines.push(`Write config to ${plan.config_path}`);
  return lines;
}

export function formatSetupSuccess(result = {}, options = {}) {
  const board = result.boards?.[0] ?? {};
  const route = result.routes?.[0] ?? {};
  const golden = findGoldenCard(board, route);
  const boardName = board.name ?? board.label ?? board.id ?? "selected board";
  const boardId = board.id ?? "unknown";
  const configPath = result.path ?? ".fizzy-symphony/config.yml";
  const runner = result.runner?.kind ?? "unknown";
  const routeLabel = formatRouteLabel(route) || "Ready for Agents -> Ready To Ship";
  const tags = golden?.tags?.length
    ? golden.tags.map((tag) => `#${normalizeTagLabel(tag)}`).join(" ")
    : "#agent-instructions #codex #move-to-ready-to-ship";
  const model = result.default_model ?? route.model ?? "";
  const reasoning = result.reasoning_effort ?? "";
  const workspaceMode = result.workspace_mode === "no_dispatch"
    ? "no dispatch"
    : "protected git worktrees";
  const maxAgents = result.max_agents ?? "";
  const startCommand = `fizzy-symphony start --config ${configPath}`;

  return [
    `${mark(options, "success")} fizzy-symphony is ready`,
    "",
    `${muted(options, "Setup wrote the route into Fizzy. The golden card is the workflow; normal cards are the work.")}`,
    "",
    `  ${label(options, "Config")} ${configPath}`,
    `  ${label(options, "Board")} ${boardName} (${boardId})`,
    `  ${label(options, "Route")} ${routeLabel}`,
    `  ${label(options, "Golden")} ${golden ? goldenTitle(golden) : "Repo Agent"} ${muted(options, tags)}`,
    `  ${label(options, "Model")} ${model || "Codex default"}`,
    `  ${label(options, "Reasoning")} ${reasoning || "medium"}`,
    `  ${label(options, "Max agents")} ${maxAgents || "1"}`,
    `  ${label(options, "Workspace")} ${workspaceMode}`,
    `  ${label(options, "Runner")} ${runner}`,
    "",
    formatBoardSnapshot(result.boards, result.routes, options),
    "",
    `${label(options, "Start watching")}`,
    `  ${startCommand}`,
    "",
    `${label(options, "Smoke test")}`,
    "  1. Leave the golden card alone; it defines the route.",
    `  2. Create a normal Fizzy card in ${route.source_column_name ?? "Ready for Agents"}.`,
    "  3. Watch this terminal. Dirty repos are protected and reported before dispatch.",
    ""
  ].join("\n");
}

export function formatDaemonStartSummary(daemon, options = {}) {
  const snapshot = daemon.status.status();
  const seconds = Math.round((daemon.config.polling?.interval_ms ?? 30000) / 1000);
  const endpoint = daemon.endpoint?.base_url ?? snapshot.endpoint?.base_url ?? "unknown";
  const configPath = options.configPath ?? snapshot.config_path ?? daemon.instance?.record?.config_path;
  const workspace = defaultWorkspace(daemon.config);
  const sourceConfig = workspace?.source ? daemon.config.workspaces?.sources?.[workspace.source] : null;
  const sourceRepo = sourceConfig?.remote_url
    ? redactGitRemoteUrl(sourceConfig.remote_url)
    : daemon.config.workspaces?.default_repo ?? workspace?.repo;
  const worktreeRoot = workspace?.worktree_root ?? daemon.config.workspaces?.root;
  const dashboardCommand = endpoint === "unknown"
    ? "fizzy-symphony dashboard"
    : `fizzy-symphony dashboard --endpoint ${endpoint}`;
  const statusCommand = endpoint === "unknown"
    ? "fizzy-symphony status"
    : `fizzy-symphony status --endpoint ${endpoint}`;
  const lines = [
    "",
    `${mark(options, "primary")} fizzy-symphony watching boards`,
    "",
    `  ${label(options, "Instance")} ${snapshot.instance?.id ?? "unknown"}`,
    `  ${label(options, "Endpoint")} ${endpoint}`,
    ...(configPath ? [`  ${label(options, "Config")} ${configPath}`] : []),
    ...(sourceRepo ? [`  ${label(options, "Source repo")} ${sourceRepo}`] : []),
    ...(worktreeRoot ? [`  ${label(options, "Worktrees")} ${worktreeRoot}`] : []),
    `  ${label(options, "Polling")} ${seconds}s`,
    `  ${label(options, "Safety")} protecting your work: dirty source repos are skipped, not overwritten`,
    ...(daemon.config.diagnostics?.no_dispatch
      ? [`  ${label(options, "Mode")} watch only: dispatch is disabled in config`]
      : []),
    `  ${label(options, "Inspect")} ${dashboardCommand}`,
    `  ${label(options, "Status")} ${statusCommand}`,
    ""
  ];

  const boards = snapshot.watched_boards ?? [];
  const routes = snapshot.routes ?? [];
  if (boards.length === 0) {
    lines.push(`  ${mark(options, "warning")} No watched boards configured.`);
    return `${lines.join("\n")}\n`;
  }

  for (const board of boards) {
    const boardRoutes = routes.filter((route) => route.board_id === board.id);
    lines.push(`  ${mark(options, "accent")} ${board.label ?? board.name ?? board.id}`);
    if (boardRoutes.length === 0) {
      lines.push(`    ${muted(options, "No golden ticket routes found on this board.")}`);
      continue;
    }
    for (const route of boardRoutes) {
      lines.push(`    ↳ ${formatRouteLabel(route)} ${muted(options, `(${route.backend ?? "codex"})`)}`);
    }
  }

  const liveBoardSnapshot = formatBoardSnapshot(options.boardSnapshots, routes, options);
  if (liveBoardSnapshot) {
    lines.push("", liveBoardSnapshot);
  }

  return `${lines.join("\n")}\n`;
}

function defaultWorkspace(config = {}) {
  const registry = config.workspaces?.registry ?? {};
  if (config.workspaces?.default && registry[config.workspaces.default]) {
    return registry[config.workspaces.default];
  }
  return Object.values(registry)[0];
}

export function formatBoardSnapshot(boards = [], routes = [], options = {}) {
  const snapshots = (boards ?? []).filter(Boolean);
  if (snapshots.length === 0) return "";

  const lines = [`${label(options, "Live board")}`];
  const maxBoards = options.maxBoards ?? 3;
  const maxCardsPerColumn = options.maxCardsPerColumn ?? 5;

  for (const board of snapshots.slice(0, maxBoards)) {
    const boardRoutes = (routes ?? []).filter((route) => route.board_id === board.id);
    lines.push(`  ${mark(options, "accent")} ${board.name ?? board.label ?? board.id}`);
    for (const column of orderedColumns(board, boardRoutes)) {
      const cards = cardsForColumn(board, column);
      lines.push(`    ${column.name ?? column.title ?? column.id} ${muted(options, cardCount(cards.length))}`);
      for (const card of cards.slice(0, maxCardsPerColumn)) {
        lines.push(`      ${formatLiveCard(card)}`);
      }
      if (cards.length > maxCardsPerColumn) {
        lines.push(`      ${muted(options, `... ${cards.length - maxCardsPerColumn} more`)}`);
      }
    }
  }

  if (snapshots.length > maxBoards) {
    lines.push(`  ${muted(options, `... ${snapshots.length - maxBoards} more boards`)}`);
  }

  return lines.join("\n");
}

export function createHumanDaemonLogger(io, options = {}) {
  const styled = { color: supportsColor(io.env ?? process.env, io.stderr) && options.color !== false };

  function write(line = "") {
    io.stderr.write(`${line}\n`);
  }

  function log(level, event, fields = {}) {
    if (event === "workspace.source_dirty_protected") {
      write(`${mark(styled, "warning")} protecting your work: source repo has local changes, so this card was not dispatched`);
      write(`  ${label(styled, "Repo")} ${fields.source_repository_path ?? "unknown"}`);
      const dirtyPaths = Array.isArray(fields.dirty_paths) ? fields.dirty_paths : [];
      for (const path of dirtyPaths.slice(0, 10)) write(`  ${label(styled, "Dirty")} ${path}`);
      if (fields.dirty_paths_truncated) write(`  ${label(styled, "Dirty")} ... ${fields.dirty_paths_count} total paths`);
      if (fields.remediation) write(`  ${label(styled, "Next")} ${fields.remediation}`);
      return;
    }

    const message = fields?.message ?? (typeof event === "string" ? event : JSON.stringify(event));
    write(`${mark(styled, markForLevel(level))} ${message}`);
  }

  return {
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
    child() {
      return this;
    }
  };
}

export function supportsColor(env = process.env, stream = process.stdout) {
  return Boolean(stream?.isTTY) && env.NO_COLOR === undefined && env.TERM !== "dumb";
}

function reviewBoardCount(plan) {
  if (plan.setup_mode === "create_starter") return 1;
  return plan.board_ids?.length ?? 0;
}

function formatRouteLabel(route = {}) {
  const source = route.source_column_name ?? route.source_column_id;
  const completion = route.completion ?? {};
  const target = completion.policy === "move_to_column"
    ? completion.target_column_name ?? completion.target_column_id
    : completion.policy;
  if (!source || !target) return "";
  return `${source} -> ${target}`;
}

function findGoldenCard(board = {}, route = {}) {
  const cards = board.cards ?? [];
  return cards.find((card) => card.id === route.golden_card_id) ??
    cards.find((card) => card.golden && hasTag(card, "agent-instructions")) ??
    cards.find((card) => card.golden) ??
    null;
}

function hasTag(card, expected) {
  return (card.tags ?? []).map(normalizeTagLabel).includes(expected);
}

function normalizeTagLabel(tag) {
  const raw = typeof tag === "string" ? tag : tag?.name ?? tag?.title ?? tag?.slug ?? tag?.label ?? "";
  return raw.trim().replace(/^#+/u, "");
}

function goldenTitle(card) {
  const number = card.number ?? card.card_number;
  return `${number ? `#${number} ` : ""}${card.title ?? "Repo Agent"}`;
}

function orderedColumns(board = {}, routes = []) {
  const columns = [...(board.columns ?? [])];
  const byId = new Map(columns.map((column) => [column.id, column]));
  const preferredIds = unique([
    ...routes.map((route) => route.source_column_id),
    ...routes.map((route) => route.completion?.target_column_id)
  ].filter(Boolean));
  const preferred = preferredIds.map((id) => byId.get(id)).filter(Boolean);
  const rest = columns.filter((column) => !preferredIds.includes(column.id));

  if (preferred.length > 0 || rest.length > 0) return [...preferred, ...rest];

  return unique((board.cards ?? []).map((card) => card.column_id).filter(Boolean))
    .map((id) => ({ id, name: id }));
}

function cardsForColumn(board = {}, column = {}) {
  return (board.cards ?? []).filter((card) => {
    const cardColumn = card.column_id ?? card.column?.id ?? card.column;
    return cardColumn === column.id || cardColumn === column.name;
  });
}

function formatLiveCard(card = {}) {
  const marker = card.golden ? "★ " : "";
  return `${marker}${goldenTitle(card)}`;
}

function cardCount(count) {
  return `${count} ${count === 1 ? "card" : "cards"}`;
}

function unique(values = []) {
  return [...new Set(values)];
}

function markForLevel(level) {
  if (level === "error") return "error";
  if (level === "warn") return "warning";
  if (level === "debug") return "dim";
  return "primary";
}

function mark(options, kind) {
  const symbol = {
    primary: "◆",
    success: "✓",
    warning: "▲",
    error: "✗",
    accent: "◇",
    dim: "·"
  }[kind] ?? "◇";
  return style(options, COLORS[kind] ?? COLORS.primary, symbol);
}

function label(options, text) {
  return style(options, COLORS.primary, `${String(text).padEnd(14, " ")} `);
}

function muted(options, text) {
  return style(options, COLORS.dim, text);
}

function style(options, code, text) {
  if (!options.color) return text;
  return `\x1b[${code}m${text}${RESET}`;
}
