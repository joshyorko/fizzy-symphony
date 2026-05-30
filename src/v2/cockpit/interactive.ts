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
import type { CockpitModel, SymphonyStatus } from "../core/types.ts";

export interface InteractiveCockpitOptions {
  runtime: SymphonyRuntime;
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
  let statusLine = "Ready. Press ? for the Factory Manual, q to quit.";
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
      filter
    });
  }

  function draw(): void {
    term.clear();
    term.moveTo(1, 1);
    term(renderCockpitText(model()));
    term(`\n\n> ${statusLine}\n`);
  }

  function submit(actionId: string): void {
    const current = model();
    const action = current.actions.find((entry) => entry.id === actionId);
    if (!action) {
      statusLine = `Action ${actionId} not available in this build.`;
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

  function handleKey(name: string): void {
    const ids = selectableIds(runtime.getStatus());
    if (name === "q" || name === "ESCAPE" || name === "CTRL_C") {
      cleanup();
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
