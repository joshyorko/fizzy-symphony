// Wonka factory theme. Theme is allowed; lies are not.
//
// Every themed label here is paired with raw truth elsewhere in the model
// (the detail panel always carries board id, card id, run id, status, etc.).
// This module is a pure lookup table with no state.

import type {
  CardRuntimeState,
  FactoryState,
  RunState,
  WarningSeverity
} from "./types.ts";

export const FACTORY_STATE_LABELS: Record<FactoryState, string> = {
  open: "Factory open",
  running: "Machines in motion",
  blocked: "Factory cannot close",
  locked: "Factory locked",
  unknown: "Status unknown"
};

export function cardThemeLabel(state: CardRuntimeState, golden: boolean): string {
  if (golden) return "Golden ticket";
  switch (state) {
    case "running":
      return "Machine in motion";
    case "queued":
      return "Queued on the line";
    case "completed":
      return "Wrapped candy";
    case "failed":
      return "Jammed machine";
    case "cancelled":
      return "Stopped machine";
    case "blocked":
      return "Hazard on the line";
    case "idle":
    default:
      return "Wonka bar";
  }
}

export function runThemeLabel(state: RunState, stalled = false): string {
  if (stalled) return "Stalled machine";
  switch (state) {
    case "running":
      return "Machine in motion";
    case "queued":
      return "Queued on the line";
    case "completed":
      return "Wrapped candy";
    case "failed":
      return "Jammed machine";
    case "cancelled":
      return "Stopped machine";
    case "preempted":
      return "Bumped from the line";
    default:
      return "Machine";
  }
}

export function worktreeThemeLabel(dirty: boolean, preserved: boolean): string {
  if (dirty) return "Spill / hazard";
  if (preserved) return "Sealed vault";
  return "Clean bench";
}

export function doctorThemeLabel(goalClosable: boolean): string {
  return goalClosable ? "Factory can close" : "Factory cannot close";
}

export function eventThemeLabel(severity: WarningSeverity): string {
  switch (severity) {
    case "error":
      return "Alarm";
    case "warning":
      return "Caution light";
    case "info":
    default:
      return "Intercom";
  }
}

export const ROUTE_THEME_LABEL = "Factory line";
