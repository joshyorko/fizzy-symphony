// Command reducer: applies a validated OperatorCommand to a SymphonyStatus.
//
// Pure: it never mutates its input and never performs IO. Given a status and a
// command that has already passed validateCommand + checkCommandAvailability,
// it returns the next status plus a human-readable summary for the audit event.
// This is the deterministic, in-memory model of "what the command does"; live
// FizzyPort / CodexRunnerPort side-effects (deferred) would be layered on top.

import type {
  CardRuntimeStatus,
  OperatorCommand,
  ReadinessStatus,
  RunBuckets,
  RunStatus,
  SymphonyStatus,
  WorktreeStatus
} from "../core/types.ts";

export interface ApplyResult {
  status: SymphonyStatus;
  summary: string;
}

function recomputeReadiness(readiness: ReadinessStatus): ReadinessStatus {
  const dispatchPaused = readiness.dispatchPaused === true;
  let state = readiness.state;
  if (dispatchPaused) {
    state = "locked";
  } else if (readiness.blockers.length > 0) {
    state = "blocked";
  } else if (readiness.ready) {
    state = "ready";
  } else {
    state = "unknown";
  }
  return { ...readiness, dispatchPaused, state };
}

function cloneRuns(runs: RunBuckets): RunBuckets {
  return {
    queued: [...runs.queued],
    running: [...runs.running],
    completed: [...runs.completed],
    failed: [...runs.failed],
    cancelled: [...runs.cancelled],
    preempted: [...runs.preempted]
  };
}

function cancelRun(run: RunStatus, at: string): RunStatus {
  return { ...run, state: "cancelled", updatedAt: at, stalled: false, error: undefined, recommendedAction: undefined };
}

function clearCardForCancel(card: CardRuntimeStatus): CardRuntimeStatus {
  return { ...card, state: "cancelled", runId: undefined };
}

export function applyCommandToStatus(
  status: SymphonyStatus,
  command: OperatorCommand,
  at: string
): ApplyResult {
  switch (command.type) {
    case "dispatch.pause": {
      const readiness = recomputeReadiness({ ...status.readiness, dispatchPaused: true });
      return { status: { ...status, readiness, lastUpdatedAt: at }, summary: "Dispatch paused (factory locked)." };
    }
    case "dispatch.resume": {
      const readiness = recomputeReadiness({ ...status.readiness, dispatchPaused: false });
      return { status: { ...status, readiness, lastUpdatedAt: at }, summary: "Dispatch resumed (factory unlocked)." };
    }
    case "run.cancel": {
      const runs = cloneRuns(status.runs);
      const run = runs.running.find((entry) => entry.id === command.runId);
      if (!run) {
        return { status: { ...status, lastUpdatedAt: at }, summary: `Run ${command.runId} was not running.` };
      }
      runs.running = runs.running.filter((entry) => entry.id !== command.runId);
      runs.cancelled = [...runs.cancelled, cancelRun(run, at)];
      const cards = status.cards.map((card) =>
        card.runId === run.id || card.id === run.cardId ? clearCardForCancel(card) : card
      );
      return {
        status: { ...status, runs, cards, lastUpdatedAt: at },
        summary: `Cancelled run ${command.runId}.`
      };
    }
    case "session.stop": {
      const runs = cloneRuns(status.runs);
      const stopped = runs.running.filter((entry) => entry.sessionId === command.sessionId);
      if (stopped.length === 0) {
        return { status: { ...status, lastUpdatedAt: at }, summary: `No running runs for session ${command.sessionId}.` };
      }
      const stoppedIds = new Set(stopped.map((entry) => entry.id));
      const stoppedCardIds = new Set(stopped.map((entry) => entry.cardId));
      runs.running = runs.running.filter((entry) => !stoppedIds.has(entry.id));
      runs.cancelled = [...runs.cancelled, ...stopped.map((entry) => cancelRun(entry, at))];
      const cards = status.cards.map((card) =>
        (card.runId && stoppedIds.has(card.runId)) || stoppedCardIds.has(card.id) ? clearCardForCancel(card) : card
      );
      return {
        status: { ...status, runs, cards, lastUpdatedAt: at },
        summary: `Stopped session ${command.sessionId} (${stopped.length} run${stopped.length === 1 ? "" : "s"}).`
      };
    }
    case "card.rerun": {
      const cards = status.cards.map((card) =>
        card.id === command.cardId ? { ...card, state: "queued" as const, runId: undefined } : card
      );
      return { status: { ...status, cards, lastUpdatedAt: at }, summary: `Queued rerun of card ${command.cardId}.` };
    }
    case "card.move": {
      const cards = status.cards.map((card) =>
        card.id === command.cardId
          ? { ...card, columnId: command.targetColumnId, columnName: undefined }
          : card
      );
      return {
        status: { ...status, cards, lastUpdatedAt: at },
        summary: `Moved card ${command.cardId} to column ${command.targetColumnId}.`
      };
    }
    case "worktree.preserve": {
      const worktrees: WorktreeStatus[] = status.worktrees.map((worktree) =>
        worktree.workspaceKey === command.workspaceKey ? { ...worktree, preserved: true } : worktree
      );
      return {
        status: { ...status, worktrees, lastUpdatedAt: at },
        summary: `Preserved worktree ${command.workspaceKey}.`
      };
    }
    case "worktree.cleanup": {
      const worktrees: WorktreeStatus[] = status.worktrees.map((worktree) =>
        worktree.workspaceKey === command.workspaceKey
          ? { ...worktree, dirty: false, preserved: false, dirtyPaths: [], lastError: undefined, recommendedAction: undefined }
          : worktree
      );
      return {
        status: { ...status, worktrees, lastUpdatedAt: at },
        summary: `Cleaned up worktree ${command.workspaceKey}.`
      };
    }
    default:
      return { status, summary: "No-op." };
  }
}
