import { FizzySymphonyError } from "./errors.js";
import { formatSetupMutationReview } from "./terminal-ui.js";

const MENU_KEY_BINDINGS = {
  ENTER: "submit",
  KP_ENTER: "submit",
  UP: "previous",
  DOWN: "next",
  TAB: "cycleNext",
  SHIFT_TAB: "cyclePrevious",
  HOME: "first",
  END: "last",
  BACKSPACE: "cancel",
  DELETE: "cancel",
  ESCAPE: "escape",
  CTRL_C: "escape",
  q: "escape",
  Q: "escape"
};

const INPUT_KEY_BINDINGS = {
  ENTER: "submit",
  KP_ENTER: "submit",
  ESCAPE: "cancel",
  CTRL_C: "cancel",
  BACKSPACE: "backDelete",
  DELETE: "delete",
  LEFT: "backward",
  RIGHT: "forward",
  UP: "historyPrevious",
  DOWN: "historyNext",
  HOME: "startOfInput",
  END: "endOfInput",
  TAB: "autoComplete",
  CTRL_R: "autoCompleteUsingHistory",
  CTRL_LEFT: "previousWord",
  CTRL_RIGHT: "nextWord",
  ALT_D: "deleteNextWord",
  CTRL_W: "deletePreviousWord"
};

const SETUP_MODE_LABELS = {
  create_starter: "Create private starter board",
  existing: "Watch existing board(s)",
  adopt_starter: "Adopt an existing starter board"
};
const SETUP_WIZARD_WIDTH = 72;

export async function createSetupWizardPromptProvider(io, env = process.env, options = {}) {
  const adapter = options.adapter ?? await createTerminalKitAdapter(io, env, options);
  if (!adapter) return null;
  return new SetupWizardPromptProvider(adapter);
}

export function shouldUseSetupWizardPromptProvider(io, env = process.env, options = {}) {
  if (options.force) return true;
  if (options.terminal) return true;
  if (env.FIZZY_SYMPHONY_PROMPTS === "plain") return false;
  if (env.CI) return false;
  if (env.TERM === "dumb") return false;
  return Boolean(io?.stdin?.isTTY) &&
    Boolean(io?.stdout?.isTTY) &&
    io.stdin === process.stdin &&
    io.stdout === process.stdout;
}

class SetupWizardPromptProvider {
  constructor(adapter) {
    this.adapter = adapter;
    this.setupMode = null;
  }

  close() {
    this.adapter.close?.();
  }

  async input(prompt = {}) {
    this.section(sectionForInput(prompt));
    return this.inputValue({
      name: prompt.name,
      message: prompt.message ?? prompt.name ?? "Value",
      defaultValue: prompt.defaultValue,
      secret: Boolean(prompt.secret)
    }, prompt.name ?? "input");
  }

  async selectAccount(accounts = []) {
    if (accounts.length <= 1) return null;

    this.section("Fizzy account");
    return this.menuValue({
      message: "Which Fizzy account should setup use?",
      choices: accounts.map((account) => ({
        value: account,
        label: accountLabel(account),
        hint: accountHint(account)
      }))
    }, "account");
  }

  async selectSetupMode(modes = []) {
    const available = modes.map(normalizeSetupMode).filter(Boolean);
    if (available.length === 0) {
      this.setupMode = "existing";
      return this.setupMode;
    }
    if (available.length === 1) {
      this.setupMode = available[0];
      return this.setupMode;
    }

    this.section("Setup lane");
    if (!available.includes("create_starter")) {
      this.setupMode = await this.modeMenu(available, "How should setup use Fizzy boards?", "setup_mode");
      return this.setupMode;
    }

    const laneChoices = [
      {
        value: "create_starter",
        label: "Create private starter board",
        hint: "builds Ready for Agents -> Ready To Ship"
      },
      {
        value: "existing_lane",
        label: "Watch or adopt an existing board",
        hint: "watch existing routes or adopt a starter-style board"
      }
    ];
    const lane = await this.menuValue({
      message: "Choose the setup lane",
      choices: laneChoices
    }, "setup_mode");

    if (lane === "create_starter") {
      this.setupMode = "create_starter";
      return this.setupMode;
    }

    const existingModes = available.filter((mode) => mode !== "create_starter");
    this.setupMode = existingModes.length === 1
      ? existingModes[0]
      : await this.modeMenu(existingModes, "What kind of existing board setup?", "setup_mode");
    return this.setupMode;
  }

  async selectBoards(boards = []) {
    if (boards.length === 0) return [];

    this.section("Board selection");
    const choices = boards.map((board) => ({
      value: board,
      label: boardLabel(board),
      hint: board.id
    }));

    if (this.setupMode === "adopt_starter") {
      const selected = await this.menuValue({
        message: "Which existing starter board should setup adopt?",
        choices
      }, "boards");
      return [selected];
    }

    if (typeof this.adapter.multiselect === "function") {
      const selected = ensureNotCancelled(await this.adapter.multiselect({
        message: "Which boards should fizzy-symphony watch?",
        choices,
        defaultValues: choices.slice(0, 1).map((choice) => choice.value),
        required: true
      }), "boards");
      return normalizeSelectionList(selected);
    }

    return this.multiselectWithMenu({
      message: "Which boards should fizzy-symphony watch?",
      choices,
      defaultValues: choices.slice(0, 1).map((choice) => choice.value)
    }, "boards");
  }

  async configureSetupDefaults(defaults = {}) {
    this.section("Operator defaults");
    const defaultModel = await this.inputValue({
      name: "default_model",
      message: "Codex model",
      defaultValue: defaults.defaultModel
    }, "defaults");
    const reasoningEffort = await this.menuValue({
      message: "Codex reasoning effort",
      choices: (defaults.reasoningEfforts ?? ["low", "medium", "high", "xhigh"]).map((effort) => ({
        value: effort,
        label: effort,
        hint: effort === defaults.reasoningEffort ? "default" : ""
      })),
      defaultValue: defaults.reasoningEffort
    }, "defaults");
    const maxAgents = await this.inputValue({
      name: "max_agents",
      message: "Max active agents",
      defaultValue: String(defaults.maxAgents ?? 1)
    }, "defaults");
    const workspaceMode = await this.menuValue({
      message: "Workspace mode",
      choices: workspaceModeChoices(defaults),
      defaultValue: defaults.workspaceMode ?? "protected_worktree"
    }, "defaults");

    return {
      defaultModel,
      reasoningEffort,
      maxAgents: numericOrRaw(maxAgents),
      workspaceMode
    };
  }

  async confirmWorkflowPolicy({ exists, path } = {}) {
    this.section("Workflow policy");
    const action = await this.menuValue({
      message: exists
        ? `WORKFLOW.md already exists at ${path}. What should setup do?`
        : `No WORKFLOW.md was found at ${path}. What should setup do?`,
      choices: exists
        ? [
          { value: "skip", label: "Leave WORKFLOW.md untouched", hint: "no repo-policy mutation" },
          { value: "append", label: "Append fizzy-symphony guidance", hint: "explicit opt-in mutation" }
        ]
        : [
          { value: "skip", label: "Skip WORKFLOW.md changes", hint: "no repo-policy mutation" },
          { value: "create", label: "Create starter WORKFLOW.md", hint: "explicit opt-in mutation" }
        ],
      defaultValue: "skip"
    }, "workflow_policy");

    return { action };
  }

  async confirmSetupMutations(plan = {}) {
    this.section("Mutation review");
    this.adapter.note?.(formatSetupMutationReview(plan, { includeInstruction: false }), "Setup plan");
    const confirmed = ensureNotCancelled(await this.adapter.confirm({
      message: "Apply these setup changes?",
      defaultValue: true
    }), "mutation_review");

    if (!confirmed) {
      throw setupCancelled("mutation_review", { reason: "declined" });
    }

    return true;
  }

  async inputValue(prompt, step) {
    const value = ensureNotCancelled(await this.adapter.input(prompt), step);
    const text = String(value ?? "");
    if (text.trim().toLowerCase() === "q") {
      throw setupCancelled(step, { key: "q" });
    }
    return text.length > 0 ? text : prompt.defaultValue ?? "";
  }

  async menuValue(prompt, step) {
    return ensureNotCancelled(await this.adapter.menu(prompt), step);
  }

  async modeMenu(modes, message, step) {
    return this.menuValue({
      message,
      choices: modes.map((mode) => ({
        value: mode,
        label: SETUP_MODE_LABELS[mode] ?? mode,
        hint: setupModeHint(mode)
      }))
    }, step);
  }

  async multiselectWithMenu(prompt, step) {
    const selected = new Set(prompt.defaultValues ?? []);

    for (;;) {
      const value = await this.menuValue({
        message: prompt.message,
        choices: [
          ...prompt.choices.map((choice) => ({
            ...choice,
            label: `${selected.has(choice.value) ? "[x]" : "[ ]"} ${choice.label}`
          })),
          { value: "__done__", label: "Done", hint: "continue with selected boards" }
        ]
      }, step);

      if (value === "__done__") {
        if (selected.size > 0) return [...selected];
        this.adapter.note?.("Select at least one board, or press q to cancel.", "Board selection");
        continue;
      }

      if (selected.has(value)) selected.delete(value);
      else selected.add(value);
    }
  }

  section(title) {
    this.adapter.section?.(title);
  }
}

async function createTerminalKitAdapter(io, env, options) {
  if (!shouldUseSetupWizardPromptProvider(io, env, options)) return null;
  const terminal = options.terminal ?? await loadTerminalKitTerminal();
  if (!terminal) return null;
  return new TerminalKitWizardAdapter(terminal, io);
}

async function loadTerminalKitTerminal() {
  const mod = await import("terminal-kit").catch(() => null);
  return mod?.terminal ?? mod?.default?.terminal ?? null;
}

class TerminalKitWizardAdapter {
  constructor(terminal, io = {}) {
    this.term = terminal;
    this.io = io;
    this.step = 0;
    this.term.grabInput?.({ mouse: "button" });
  }

  section(title) {
    this.step += 1;
    this.write(`\n${setupFrame(`Step ${this.step}: ${title}`, [
      "fizzy-symphony setup wizard",
      "↑/↓ or Tab moves   Enter/click selects   Esc/q cancels"
    ])}\n`);
  }

  note(text, title) {
    this.write(`\n${title}\n${text}\n`);
  }

  async input(prompt = {}) {
    this.write(`${prompt.message}${prompt.defaultValue ? ` (${prompt.defaultValue})` : ""}: `);
    const controller = this.term.inputField({
      default: prompt.defaultValue ? String(prompt.defaultValue) : "",
      echo: !prompt.secret,
      echoChar: prompt.secret ? "*" : undefined,
      cancelable: true,
      keyBindings: INPUT_KEY_BINDINGS
    });
    const value = await this.withCancelKeys(controller, controller.promise, { q: false });
    this.write("\n");
    if (value === undefined) return { canceled: true, key: "ESCAPE" };
    return value;
  }

  async menu(prompt = {}) {
    this.write(`\n${prompt.message}\n`);
    const choices = prompt.choices ?? [];
    const selectedIndex = Math.max(0, choices.findIndex((choice) => choice.value === prompt.defaultValue));
    const controller = this.term.singleColumnMenu(choices.map(formatMenuItem), {
      cancelable: true,
      selectedIndex,
      keyBindings: MENU_KEY_BINDINGS
    });
    const result = await this.withCancelKeys(controller, controller.promise);
    this.write("\n");
    if (result?.canceled || result?.unexpectedKey) {
      return { canceled: true, key: result.unexpectedKey ?? result.key ?? "ESCAPE" };
    }
    return choices[result.selectedIndex]?.value;
  }

  async confirm(prompt = {}) {
    this.write(`${prompt.message} ${prompt.defaultValue === false ? "[y/N]" : "[Y/n]"} `);
    const controller = this.term.yesOrNo({
      yes: prompt.defaultValue === false ? ["y", "Y"] : ["y", "Y", "ENTER", "KP_ENTER"],
      no: prompt.defaultValue === false ? ["n", "N", "ENTER", "KP_ENTER"] : ["n", "N"],
      echoYes: "yes\n",
      echoNo: "no\n"
    });
    return this.withCancelKeys(controller, controller.promise);
  }

  async multiselect(prompt = {}) {
    const selected = new Set(prompt.defaultValues ?? []);

    for (;;) {
      const value = await this.menu({
        message: prompt.message,
        choices: [
          ...(prompt.choices ?? []).map((choice) => ({
            ...choice,
            label: `${selected.has(choice.value) ? "[x]" : "[ ]"} ${choice.label}`
          })),
          { value: "__done__", label: "Done", hint: "continue with selected boards" }
        ]
      });

      if (isCancelled(value)) return value;
      if (value === "__done__") {
        if (!prompt.required || selected.size > 0) return [...selected];
        this.note("Select at least one board, or press q to cancel.", "Board selection");
        continue;
      }

      if (selected.has(value)) selected.delete(value);
      else selected.add(value);
    }
  }

  withCancelKeys(controller, promise, options = {}) {
    if (!this.term.on || !this.term.removeListener) return promise;

    const cancelKeys = new Set(["ESCAPE", "CTRL_C"]);
    if (options.q !== false) {
      cancelKeys.add("q");
      cancelKeys.add("Q");
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.term.removeListener("key", onKey);
      };
      const finish = (action, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        action(value);
      };
      const onKey = (key) => {
        if (!cancelKeys.has(key)) return;
        controller?.abort?.();
        finish(resolve, { canceled: true, key });
      };

      this.term.on("key", onKey);
      Promise.resolve(promise).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    });
  }

  write(text) {
    if (typeof this.term === "function") {
      this.term(text);
      return;
    }
    if (typeof this.term.write === "function") {
      this.term.write(text);
      return;
    }
    this.io.stdout?.write?.(text);
  }

  close() {
    this.term.grabInput?.(false);
  }
}

function ensureNotCancelled(value, step) {
  if (isCancelled(value) || value === undefined) {
    throw setupCancelled(step, {
      key: value?.key,
      reason: value?.reason
    });
  }
  return value;
}

function setupCancelled(step, details = {}) {
  return new FizzySymphonyError("SETUP_CANCELLED", "Setup wizard cancelled.", {
    step,
    ...stripEmpty(details)
  });
}

function stripEmpty(details) {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined && value !== "")
  );
}

function isCancelled(value) {
  return Boolean(value?.canceled || value?.cancelled);
}

function sectionForInput(prompt = {}) {
  if (String(prompt.name ?? "").startsWith("fizzy_api_")) return "Credentials";
  return "Setup input";
}

function accountLabel(account = {}) {
  return account.name ?? account.slug ?? account.path ?? account.id ?? "Account";
}

function accountHint(account = {}) {
  return account.slug ?? account.path ?? account.id ?? "";
}

function boardLabel(board = {}) {
  return board.name ?? board.label ?? board.title ?? board.id ?? "Board";
}

function setupModeHint(mode) {
  if (mode === "create_starter") return "private starter route to Ready To Ship";
  if (mode === "adopt_starter") return "single existing starter route";
  if (mode === "existing") return "watch selected boards";
  return "";
}

function normalizeSetupMode(mode) {
  const normalized = String(mode ?? "").trim().replaceAll("-", "_");
  if (!normalized) return "";
  if (normalized === "starter" || normalized === "new_board") return "create_starter";
  return normalized;
}

function workspaceModeChoices(defaults = {}) {
  const allowed = defaults.workspaceModes ?? ["protected_worktree", "no_dispatch"];
  return allowed.map((mode) => {
    if (mode === "protected_worktree") {
      return {
        value: mode,
        label: "Protected git worktrees",
        hint: "keeps card edits outside the source repo"
      };
    }
    if (mode === "no_dispatch") {
      return {
        value: mode,
        label: "Watch only",
        hint: "no agents run until config changes"
      };
    }
    return { value: mode, label: mode, hint: "" };
  });
}

function numericOrRaw(value) {
  const number = Number(value);
  return Number.isInteger(number) && String(value).trim() !== "" ? number : value;
}

function normalizeSelectionList(selected) {
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

function setupFrame(title, body = []) {
  const width = SETUP_WIZARD_WIDTH;
  const heading = ` ${title} `;
  const topFill = "─".repeat(Math.max(1, width - heading.length - 2));
  return [
    `┌${heading}${topFill}┐`,
    ...body.map((line) => `│ ${fitSetupLine(line, width - 4)} │`),
    `└${"─".repeat(width - 2)}┘`
  ].join("\n");
}

function fitSetupLine(value, width) {
  const text = String(value ?? "");
  if (text.length === width) return text;
  if (text.length < width) return text.padEnd(width, " ");
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

function formatMenuItem(choice = {}) {
  return choice.hint ? `${choice.label} - ${choice.hint}` : choice.label;
}
