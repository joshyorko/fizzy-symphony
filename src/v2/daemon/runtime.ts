// v2 daemon runtime (fixture-backed for the spike).
//
// Holds the current SymphonyStatus, an event log, and the capability set.
// It is the ONLY place commands are applied. Commands are validated, checked
// for availability, then (in the spike) executed as dry-run while still
// writing an audit event. Real mutation would call FizzyPort / CodexRunnerPort
// here — never from the cockpit or renderer.

import { deriveCapabilities } from "../core/capabilities.ts";
import {
  checkCommandAvailability,
  rejectedResult,
  unavailableResult,
  validateCommand
} from "../core/commands.ts";
import { createEventLog } from "../core/events.ts";
import { normalizeStatus } from "../core/status.ts";
import { applyCommandToStatus } from "./apply-command.ts";
import type { EventLog } from "../core/events.ts";
import type {
  Capability,
  CodexRunnerPort,
  CommandResult,
  FizzyPort,
  RuntimeEvent,
  SymphonyStatus
} from "../core/types.ts";

export interface RuntimeOptions {
  status: Partial<SymphonyStatus>;
  events?: RuntimeEvent[];
  capabilities?: Capability[];
  fizzy?: FizzyPort;
  codex?: CodexRunnerPort;
  // When false (default for the spike) commands are dry-run only and never
  // mutate Fizzy/Codex; the audit event records the intent.
  applyCommands?: boolean;
  now?: () => Date;
}

export interface SymphonyRuntime {
  getStatus(): SymphonyStatus;
  getCapabilities(): Capability[];
  getEvents(count?: number): RuntimeEvent[];
  getRun(runId: string): SymphonyStatus["runs"]["running"][number] | undefined;
  getWorktrees(): SymphonyStatus["worktrees"];
  submitCommand(payload: unknown): CommandResult;
  describePorts(): { fizzy: ReturnType<FizzyPort["describe"]> | null; codex: ReturnType<CodexRunnerPort["describe"]> | null };
}

export function createRuntime(options: RuntimeOptions): SymphonyRuntime {
  const applyCommands = options.applyCommands ?? false;
  const now = options.now ?? (() => new Date());
  let status = normalizeStatus(options.status);
  const eventLog: EventLog = createEventLog({ now: options.now });
  for (const event of options.events ?? status.recentEvents ?? []) {
    eventLog.append({
      type: event.type,
      severity: event.severity,
      message: event.message,
      boardId: event.boardId,
      cardId: event.cardId,
      cardNumber: event.cardNumber,
      runId: event.runId,
      sessionId: event.sessionId,
      workspacePath: event.workspacePath,
      data: event.data
    });
  }

  const explicitCapabilities =
    options.capabilities && options.capabilities.length > 0 ? options.capabilities : null;

  function currentCapabilities(): Capability[] {
    return explicitCapabilities ?? deriveCapabilities(status);
  }

  function allRuns() {
    return [
      ...status.runs.running,
      ...status.runs.queued,
      ...status.runs.completed,
      ...status.runs.failed,
      ...status.runs.cancelled,
      ...status.runs.preempted
    ];
  }

  function submitCommand(payload: unknown): CommandResult {
    const validation = validateCommand(payload);
    if (!validation.ok || !validation.command) {
      return rejectedResult(validation.code ?? "INVALID_COMMAND", validation.message ?? "Invalid command.");
    }
    const command = validation.command;
    const availability = checkCommandAvailability(command, status);
    if (!availability.available) {
      return unavailableResult(
        command.type,
        availability.code ?? "UNAVAILABLE",
        availability.reason ?? "Command unavailable."
      );
    }

    if (!applyCommands) {
      const event = eventLog.append({
        type: `command.dry-run.${command.type}`,
        severity: "info",
        message: `Dry-run accepted command ${command.type}`,
        runId: "runId" in command ? command.runId : undefined,
        sessionId: "sessionId" in command ? command.sessionId : undefined,
        cardId: "cardId" in command ? command.cardId : undefined,
        data: command
      });
      return {
        outcome: "dry-run",
        commandType: command.type,
        message: `Command ${command.type} accepted as dry-run (spike build).`,
        event
      };
    }

    // Apply the command to the in-memory status model. Live FizzyPort /
    // CodexRunnerPort side-effects (deferred) would be layered on top of this.
    const applied = applyCommandToStatus(status, command, now().toISOString());
    status = applied.status;
    const event = eventLog.append({
      type: `command.accepted.${command.type}`,
      severity: "info",
      message: applied.summary,
      runId: "runId" in command ? command.runId : undefined,
      sessionId: "sessionId" in command ? command.sessionId : undefined,
      cardId: "cardId" in command ? command.cardId : undefined,
      workspacePath: "workspaceKey" in command ? command.workspaceKey : undefined,
      data: command
    });
    return { outcome: "accepted", commandType: command.type, message: applied.summary, event };
  }

  return {
    getStatus() {
      return { ...status, recentEvents: eventLog.recent(20), capabilities: currentCapabilities() };
    },
    getCapabilities() {
      return currentCapabilities().map((capability) => ({ ...capability }));
    },
    getEvents(count = 20) {
      return eventLog.recent(count);
    },
    getRun(runId: string) {
      return allRuns().find((run) => run.id === runId);
    },
    getWorktrees() {
      return status.worktrees.map((worktree) => ({ ...worktree }));
    },
    submitCommand,
    describePorts() {
      return {
        fizzy: options.fizzy ? options.fizzy.describe() : null,
        codex: options.codex ? options.codex.describe() : null
      };
    }
  };
}
