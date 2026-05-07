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
    lines.push("  Type yes to apply, or press Enter to keep the repo untouched.");
  }

  return lines.join("\n");
}

export function setupMutationLines(plan = {}) {
  const lines = [];
  if (plan.workflow?.action === "create") lines.push(`Create WORKFLOW.md at ${plan.workflow.path}`);
  if (plan.workflow?.action === "append") lines.push(`Append a fizzy-symphony section to ${plan.workflow.path}`);
  if (plan.setup_mode === "create_starter") lines.push(`Create starter board "${plan.starter_board_name}"`);
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
  const routeLabel = formatRouteLabel(route) || "Ready for Agents -> Done";
  const tags = golden?.tags?.length
    ? golden.tags.map((tag) => `#${normalizeTagLabel(tag)}`).join(" ")
    : "#agent-instructions #codex #move-to-done";
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
    `  ${label(options, "Runner")} ${runner}`,
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
  const lines = [
    "",
    `${mark(options, "primary")} fizzy-symphony watching boards`,
    "",
    `  ${label(options, "Instance")} ${snapshot.instance?.id ?? "unknown"}`,
    `  ${label(options, "Endpoint")} ${endpoint}`,
    `  ${label(options, "Polling")} ${seconds}s`,
    `  ${label(options, "Safety")} protecting your work: dirty source repos are skipped, not overwritten`,
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

  return `${lines.join("\n")}\n`;
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

export async function createClackPromptProvider(io, env = process.env) {
  if (!shouldUseClackPrompts(io, env)) return null;
  const prompts = await import("@clack/prompts").catch(() => null);
  if (!prompts) return null;

  return {
    async input(prompt) {
      const value = prompt.secret
        ? await prompts.password({ message: prompt.message })
        : await prompts.text({
          message: prompt.message,
          placeholder: prompt.defaultValue,
          defaultValue: prompt.defaultValue
        });
      return cancelToEmpty(prompts, value);
    },

    async selectAccount(accounts = []) {
      if (accounts.length <= 1) return null;
      const value = await prompts.select({
        message: "Which Fizzy account?",
        options: accounts.map((account) => ({
          value: account,
          label: account.name ?? account.id ?? account.slug ?? "Account",
          hint: account.slug ?? account.path ?? account.id
        }))
      });
      return cancelToEmpty(prompts, value);
    },

    async selectBoards(boards = []) {
      const value = await prompts.multiselect({
        message: "Which boards should fizzy-symphony watch?",
        required: true,
        options: boards.map((board) => ({
          value: board,
          label: board.name ?? board.label ?? board.id,
          hint: board.id
        }))
      });
      return cancelToEmpty(prompts, value);
    },

    async confirmWorkflowPolicy({ exists, path }) {
      if (exists) {
        const value = await prompts.confirm({
          message: `Append fizzy-symphony agent guidance to ${path}?`,
          initialValue: false
        });
        return cancelToEmpty(prompts, value) ? { action: "append" } : { action: "skip" };
      }

      const value = await prompts.confirm({
        message: `Create WORKFLOW.md for this repo?`,
        initialValue: false
      });
      return cancelToEmpty(prompts, value) ? { action: "create" } : { action: "skip" };
    },

    async confirmSetupMutations(plan) {
      prompts.note(formatSetupMutationReview(plan, { includeInstruction: false }), "Setup plan");
      const value = await prompts.confirm({
        message: "Apply these setup changes?",
        initialValue: false
      });
      return cancelToEmpty(prompts, value);
    }
  };
}

export function shouldUseClackPrompts(io, env = process.env) {
  if (env.FIZZY_SYMPHONY_PROMPTS === "plain") return false;
  if (env.CI) return false;
  if (env.TERM === "dumb") return false;
  return Boolean(io.stdin?.isTTY) &&
    Boolean(io.stdout?.isTTY) &&
    io.stdin === process.stdin &&
    io.stdout === process.stdout;
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

function cancelToEmpty(prompts, value) {
  return prompts.isCancel?.(value) ? "" : value;
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
