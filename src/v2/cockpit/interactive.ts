// Interactive Terminal Kit cockpit renderer.
//
// This is the only place Terminal Kit is touched. It draws the pure
// CockpitModel and routes keypresses to:
//   - navigation/selection/filter/help (read-only, re-derives the model)
//   - command requests (delegated to runtime.submitCommand)
//
// It NEVER calls Fizzy/Codex, never mutates status, never spawns processes.
// Mutations only ever happen through runtime.submitCommand (typed commands).

import { createCockpitModel } from "./model.ts";
import { renderCockpitText } from "./renderer.ts";
import type { SymphonyRuntime } from "../daemon/runtime.ts";
import type { CockpitAdvancedCommand, CockpitApp, CockpitModel, CockpitSectionId, SymphonyStatus } from "../core/types.ts";

export interface InteractiveCockpitOptions {
  runtime: SymphonyRuntime;
  app?: CockpitApp;
  // Render styling for the live frames. Color defaults to on (interactive mode
  // only runs on a real TTY); width defaults to the terminal width.
  color?: boolean;
  width?: number;
  // Injected for tests; defaults to dynamically importing terminal-kit.
  terminalFactory?: () => Promise<TerminalLike>;
}

// Minimal slice of the terminal-kit Terminal surface we rely on.
export interface TerminalLike {
  fullscreen(on: boolean): void;
  clear(): void;
  moveTo(x: number, y: number): void;
  hideCursor(on?: boolean): void;
  grabInput(options: boolean | Record<string, unknown>): void;
  on(event: "key", handler: (name: string) => void): void;
  off?(event: "key", handler: (name: string) => void): void;
  width?: number;
  (text: string): void;
}

function selectableIds(status: SymphonyStatus): string[] {
  const ids: string[] = [];
  for (const card of status.cards) ids.push(card.id);
  for (const run of status.runs.running) ids.push(run.id);
  for (const worktree of status.worktrees) ids.push(worktree.workspaceKey);
  return ids;
}

const ACTION_KEY_TO_ID: Record<string, string> = {
  p: "dispatch.pause",
  u: "dispatch.resume",
  c: "run.cancel",
  s: "session.stop",
  R: "card.rerun"
};

const SECTION_BY_KEY: Record<string, string> = {
  f: "factory",
  "1": "factory",
  "2": "runs",
  w: "worktrees",
  "3": "worktrees",
  d: "doctor",
  "4": "doctor",
  m: "manual",
  "5": "manual",
  e: "events",
  "6": "events",
  S: "settings",
  "7": "settings",
  "8": "advanced"
};

type PalettePrefix = "action" | "advanced";

async function defaultTerminalFactory(): Promise<TerminalLike> {
  const mod = await import("terminal-kit");
  return (mod.terminal ?? (mod as { default?: { terminal: TerminalLike } }).default?.terminal) as TerminalLike;
}

export interface InteractiveSession {
  // Resolves when the user quits.
  done: Promise<void>;
  // For tests: simulate a key without a real TTY.
  handleKey(name: string): void;
  currentModel(): CockpitModel;
}

// Starts the interactive loop. Returns a session handle whose `done` promise
// resolves on quit. Pure model derivation happens on every keypress.
export async function startInteractiveCockpit(
  options: InteractiveCockpitOptions
): Promise<InteractiveSession> {
  const runtime = options.runtime;
  const term = await (options.terminalFactory ?? defaultTerminalFactory)();

  let selectedIndex = 0;
  let filter: string | undefined;
  // While capturing, keystrokes edit `filterDraft` instead of triggering
  // navigation/actions; the draft is applied to `filter` live as you type.
  // Enter keeps the applied filter and exits capture; Esc clears it.
  let filterCapturing = false;
  let filterDraft = "";
  let statusLine = "Ready. Press ? for the Factory Manual, q to quit.";
  let selectedSectionId: CockpitSectionId = "factory";
  let commandPaletteOpen = false;
  let palettePrefix: PalettePrefix | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  function model(): CockpitModel {
    const status = runtime.getStatus();
    const ids = selectableIds(status);
    const selectedId = ids.length > 0 ? ids[Math.max(0, Math.min(selectedIndex, ids.length - 1))] : undefined;
    return createCockpitModel({
      status,
      events: runtime.getEvents(20),
      capabilities: runtime.getCapabilities(),
      selectedId,
      filter,
      selectedSectionId,
      commandPaletteOpen,
      app: options.app
    });
  }

  function draw(): void {
    term.clear();
    term.moveTo(1, 1);
    const renderOptions = {
      color: options.color ?? true,
      width: options.width ?? term.width ?? 100
    };
    term(renderCockpitText(model(), renderOptions));
    term(`\n\n> ${statusLine}\n`);
  }

  function submit(actionId: string): void {
    const current = model();
    const action = current.actions.find((entry) => entry.id === actionId);
    if (!action) {
      statusLine = `Action ${actionId} not available in this build.`;
      return;
    }
    // DEMO is fixture data, not a live daemon. Refuse to dispatch any mutating
    // action — never enqueue a command, never emit a dry-run event. This is the
    // behavioral half of DEMO honesty; the renderer is the visual half.
    if (current.app.mode === "DEMO" && action.commandType) {
      statusLine = `${action.label} disabled: fixture data (DEMO) — connect a live daemon to act.`;
      return;
    }
    if (!action.enabled || !action.commandType) {
      statusLine = `${action.label} disabled: ${action.disabledReason ?? "unavailable"}`;
      return;
    }
    const selection = current.selected;
    const command = buildCommand(action.commandType, selection);
    if (!command) {
      statusLine = `${action.label} disabled: no valid target selected.`;
      return;
    }
    const result = runtime.submitCommand(command);
    statusLine = `${result.outcome.toUpperCase()}: ${result.message}`;
  }

  function showAdvancedCommand(command: CockpitAdvancedCommand): void {
    if (!command.enabled) {
      statusLine = `${command.label} disabled: ${command.disabledReason ?? "unavailable"}`;
      return;
    }
    statusLine = `${command.label}: ${command.command}`;
  }

  function dispatchPalette(prefix: PalettePrefix, key: string): void {
    const current = model();
    if (prefix === "action") {
      const action = current.actions.find((entry) => entry.key === key);
      if (!action) {
        statusLine = `Palette action ${key} not available.`;
        return;
      }
      submit(action.id);
      return;
    }

    const command = current.advancedCommands.find((entry) => entry.key === key);
    if (!command) {
      statusLine = `Palette command ${key} not available.`;
      return;
    }
    showAdvancedCommand(command);
  }

  function handlePaletteKey(name: string): boolean {
    // Esc dismisses the palette overlay (consistent with Esc clearing the
    // filter overlay) rather than falling through to the global quit branch.
    if (name === "ESCAPE") {
      commandPaletteOpen = false;
      palettePrefix = undefined;
      statusLine = "Command palette closed.";
      draw();
      return true;
    }
    const directPaletteKey = /^([AV]):(.+)$/u.exec(name);
    if (directPaletteKey) {
      dispatchPalette(directPaletteKey[1] === "A" ? "action" : "advanced", directPaletteKey[2]);
      palettePrefix = undefined;
      commandPaletteOpen = false;
      draw();
      return true;
    }

    if (palettePrefix) {
      const prefix = palettePrefix;
      palettePrefix = undefined;
      dispatchPalette(prefix, name);
      commandPaletteOpen = false;
      draw();
      return true;
    }

    if (name === "A") {
      palettePrefix = "action";
      statusLine = "Palette action prefix: press an action key.";
      draw();
      return true;
    }

    if (name === "V") {
      palettePrefix = "advanced";
      statusLine = "Palette advanced prefix: press a command key.";
      draw();
      return true;
    }

    const sectionRow = model().commandPalette.find((row) => row.key === name && row.section);
    if (sectionRow?.section) {
      selectedSectionId = sectionRow.section;
      commandPaletteOpen = false;
      statusLine = `Section: ${selectedSectionId}`;
      draw();
      return true;
    }

    return false;
  }

  // Live count of cards that survive the current filter, for the status line.
  function filteredCardCount(): number {
    return model().lanes.reduce((total, lane) => total + lane.cards.length, 0);
  }

  // Minimal filter input. While capturing, every key edits the draft (which is
  // applied live so the lanes narrow as you type); Enter keeps it, Esc clears.
  // This only touches the status line + the model's existing `filter` input, so
  // the pure renderer and non-TTY output are unaffected.
  function handleFilterKey(name: string): void {
    // Ctrl-C always quits, even mid-filter — it is the universal escape hatch.
    if (name === "CTRL_C") {
      cleanup();
      return;
    }
    if (name === "ENTER") {
      filterCapturing = false;
      filter = filterDraft.length > 0 ? filterDraft : undefined;
      const count = filteredCardCount();
      statusLine = filter
        ? `filter "${filter}" — ${count} card${count === 1 ? "" : "s"} match. Press / to edit, Esc to clear.`
        : "filter cleared.";
      draw();
      return;
    }
    if (name === "ESCAPE") {
      filterCapturing = false;
      filterDraft = "";
      filter = undefined;
      statusLine = "filter cleared.";
      draw();
      return;
    }
    if (name === "BACKSPACE") {
      filterDraft = filterDraft.slice(0, -1);
    } else if (name === "SPACE") {
      filterDraft += " ";
    } else if ([...name].length === 1) {
      filterDraft += name;
    }
    // Apply the draft live so the visible card count reflects what you typed.
    filter = filterDraft.length > 0 ? filterDraft : undefined;
    statusLine = `filter: ${filterDraft}▏  (${filteredCardCount()} match · Enter to keep · Esc to clear)`;
    draw();
  }

  function handleKey(name: string): void {
    if (filterCapturing) {
      handleFilterKey(name);
      return;
    }
    const ids = selectableIds(runtime.getStatus());
    if (commandPaletteOpen && handlePaletteKey(name)) {
      return;
    }
    if (name === "q" || name === "ESCAPE" || name === "CTRL_C") {
      cleanup();
      return;
    }
    if (name === "/" && !commandPaletteOpen) {
      filterCapturing = true;
      filterDraft = filter ?? "";
      statusLine = `filter: ${filterDraft}▏  (type to narrow · Enter to keep · Esc to clear)`;
      draw();
      return;
    }
    if (name === "CTRL_P") {
      commandPaletteOpen = !commandPaletteOpen;
      palettePrefix = undefined;
      statusLine = commandPaletteOpen ? "Command palette open." : "Command palette closed.";
      draw();
      return;
    }
    if (name in SECTION_BY_KEY) {
      selectedSectionId = SECTION_BY_KEY[name] as typeof selectedSectionId;
      statusLine = `Section: ${selectedSectionId}`;
      draw();
      return;
    }
    if (name === "r") {
      statusLine = "Refreshed.";
    } else if (name === "?") {
      statusLine = model().help.manualTitle;
    } else if (name === "UP" || name === "k") {
      selectedIndex = Math.max(0, selectedIndex - 1);
    } else if (name === "DOWN" || name === "j") {
      selectedIndex = Math.min(Math.max(0, ids.length - 1), selectedIndex + 1);
    } else if (name === "a") {
      const actions = model().actions.map((entry) => `${entry.key}:${entry.enabled ? "on" : "off"}`).join(" ");
      statusLine = `Actions ${actions}`;
    } else if (ACTION_KEY_TO_ID[name]) {
      submit(ACTION_KEY_TO_ID[name]);
    }
    draw();
  }

  function cleanup(): void {
    try {
      term.grabInput(false);
      term.hideCursor(false);
      term.fullscreen(false);
    } catch {
      // best-effort terminal restore
    }
    resolveDone();
  }

  if (typeof term.fullscreen === "function") term.fullscreen(true);
  if (typeof term.hideCursor === "function") term.hideCursor(true);
  if (typeof term.grabInput === "function") term.grabInput({ mouse: false });
  if (typeof term.on === "function") term.on("key", handleKey);
  draw();

  return {
    done,
    handleKey,
    currentModel: model
  };
}

function buildCommand(
  commandType: string,
  selection: CockpitModel["selected"]
): unknown {
  switch (commandType) {
    case "dispatch.pause":
      return { type: "dispatch.pause" };
    case "dispatch.resume":
      return { type: "dispatch.resume" };
    case "run.cancel":
      return selection?.raw?.runId
        ? { type: "run.cancel", runId: String(selection.raw.runId), reason: "operator cockpit" }
        : undefined;
    case "session.stop":
      return selection?.raw?.sessionId
        ? { type: "session.stop", sessionId: String(selection.raw.sessionId), reason: "operator cockpit" }
        : undefined;
    case "card.rerun":
      return selection?.kind === "card" && selection.id
        ? { type: "card.rerun", cardId: selection.id, reason: "operator cockpit" }
        : undefined;
    default:
      return undefined;
  }
}
