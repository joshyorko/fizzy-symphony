// Command model: every mutation is a typed operator command.
//
// This module is pure. It validates the *shape* of a command and decides
// whether the command is currently available given a status snapshot. It does
// NOT perform any mutation; execution lives in the daemon runtime, which emits
// an audit event when a command is accepted.

import type {
  CommandResult,
  CommandValidation,
  OperatorCommand,
  OperatorCommandType,
  SymphonyStatus
} from "./types.ts";

const KNOWN_TYPES = new Set<OperatorCommandType>([
  "dispatch.pause",
  "dispatch.resume",
  "run.cancel",
  "session.stop",
  "card.rerun",
  "card.move",
  "worktree.preserve",
  "worktree.cleanup"
]);

function requireString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Validate that an unknown payload is a well-formed OperatorCommand.
export function validateCommand(payload: unknown): CommandValidation {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, code: "INVALID_COMMAND", message: "Command must be an object." };
  }
  const command = payload as Record<string, unknown>;
  const type = command.type;
  if (typeof type !== "string" || !KNOWN_TYPES.has(type as OperatorCommandType)) {
    return { ok: false, code: "UNKNOWN_COMMAND", message: `Unknown command type: ${String(type)}` };
  }

  switch (type as OperatorCommandType) {
    case "dispatch.pause":
    case "dispatch.resume":
      return { ok: true, command: { type } as OperatorCommand };
    case "run.cancel":
      if (!requireString(command.runId)) {
        return { ok: false, code: "MISSING_FIELD", message: "run.cancel requires runId." };
      }
      if (!requireString(command.reason)) {
        return { ok: false, code: "MISSING_REASON", message: "run.cancel requires a reason." };
      }
      return { ok: true, command: command as OperatorCommand };
    case "session.stop":
      if (!requireString(command.sessionId)) {
        return { ok: false, code: "MISSING_FIELD", message: "session.stop requires sessionId." };
      }
      if (!requireString(command.reason)) {
        return { ok: false, code: "MISSING_REASON", message: "session.stop requires a reason." };
      }
      return { ok: true, command: command as OperatorCommand };
    case "card.rerun":
      if (!requireString(command.cardId)) {
        return { ok: false, code: "MISSING_FIELD", message: "card.rerun requires cardId." };
      }
      if (!requireString(command.reason)) {
        return { ok: false, code: "MISSING_REASON", message: "card.rerun requires a reason." };
      }
      return { ok: true, command: command as OperatorCommand };
    case "card.move":
      if (!requireString(command.cardId) || !requireString(command.targetColumnId)) {
        return { ok: false, code: "MISSING_FIELD", message: "card.move requires cardId and targetColumnId." };
      }
      if (!requireString(command.reason)) {
        return { ok: false, code: "MISSING_REASON", message: "card.move requires a reason." };
      }
      return { ok: true, command: command as OperatorCommand };
    case "worktree.preserve":
    case "worktree.cleanup":
      if (!requireString(command.workspaceKey)) {
        return { ok: false, code: "MISSING_FIELD", message: `${type} requires workspaceKey.` };
      }
      if (!requireString(command.reason)) {
        return { ok: false, code: "MISSING_REASON", message: `${type} requires a reason.` };
      }
      return { ok: true, command: command as OperatorCommand };
    default:
      return { ok: false, code: "UNKNOWN_COMMAND", message: "Unknown command." };
  }
}

export interface AvailabilityCheck {
  available: boolean;
  code?: string;
  reason?: string;
}

// Decide whether a (valid) command can be applied against the current status.
// This does not mutate; it only reports availability + reason. The spike runs
// commands as dry-run by default, but availability still reflects real state.
export function checkCommandAvailability(
  command: OperatorCommand,
  status: SymphonyStatus
): AvailabilityCheck {
  const running = status.runs?.running ?? [];
  switch (command.type) {
    case "dispatch.pause":
      if (status.readiness?.dispatchPaused) {
        return { available: false, code: "ALREADY_PAUSED", reason: "Dispatch already paused." };
      }
      return { available: true };
    case "dispatch.resume":
      if (!status.readiness?.dispatchPaused) {
        return { available: false, code: "NOT_PAUSED", reason: "Dispatch is not paused." };
      }
      return { available: true };
    case "run.cancel": {
      const run = running.find((entry) => entry.id === command.runId);
      if (!run) {
        return { available: false, code: "NO_ACTIVE_RUN", reason: "Selected run is not running." };
      }
      return { available: true };
    }
    case "session.stop": {
      const run = running.find((entry) => entry.sessionId === command.sessionId);
      if (!run) {
        return { available: false, code: "NO_ACTIVE_SESSION", reason: "No active session with that id." };
      }
      return { available: true };
    }
    case "card.rerun": {
      const card = status.cards?.find((entry) => entry.id === command.cardId);
      if (!card) {
        return { available: false, code: "UNKNOWN_CARD", reason: "Card not found in status." };
      }
      if (card.state === "running") {
        return { available: false, code: "CARD_RUNNING", reason: "Card already has an active run." };
      }
      return { available: true };
    }
    case "card.move": {
      const card = status.cards?.find((entry) => entry.id === command.cardId);
      if (!card) {
        return { available: false, code: "UNKNOWN_CARD", reason: "Card not found in status." };
      }
      return { available: true };
    }
    case "worktree.preserve":
    case "worktree.cleanup": {
      const worktree = status.worktrees?.find((entry) => entry.workspaceKey === command.workspaceKey);
      if (!worktree) {
        return { available: false, code: "UNKNOWN_WORKTREE", reason: "Worktree not found in status." };
      }
      return { available: true };
    }
    default:
      return { available: false, code: "UNKNOWN_COMMAND", reason: "Unknown command." };
  }
}

export function unavailableResult(type: OperatorCommandType, code: string, message: string): CommandResult {
  return { outcome: "unavailable", commandType: type, code, message };
}

export function rejectedResult(code: string, message: string): CommandResult {
  return { outcome: "rejected", code, message };
}
