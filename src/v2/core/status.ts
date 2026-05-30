// Status model normalization.
//
// Accepts a partial / loosely-shaped status object (e.g. from a fixture, the
// v2 daemon runtime, or a v1->v2 bridge) and returns a fully-populated,
// schema-stamped SymphonyStatus. Pure: never mutates input, never does IO.

import {
  STATUS_SCHEMA_VERSION
} from "./types.ts";
import type {
  FactoryState,
  ReadinessState,
  ReadinessStatus,
  RunBuckets,
  SymphonyStatus
} from "./types.ts";

function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

function emptyRunBuckets(): RunBuckets {
  return {
    queued: [],
    running: [],
    completed: [],
    failed: [],
    cancelled: [],
    preempted: []
  };
}

function normalizeReadiness(input: Partial<ReadinessStatus> | undefined): ReadinessStatus {
  const blockers = asArray(input?.blockers);
  const dispatchPaused = input?.dispatchPaused === true;
  let state: ReadinessState = input?.state ?? "unknown";
  if (!input?.state) {
    if (blockers.length > 0) state = "blocked";
    else if (input?.ready) state = "ready";
  }
  return {
    state,
    ready: input?.ready ?? state === "ready",
    blockers,
    dispatchPaused,
    runnerStatus: input?.runnerStatus
  };
}

// Map readiness + runtime activity to the themed factory state.
export function deriveFactoryState(status: SymphonyStatus): FactoryState {
  const readiness = status.readiness;
  if (!readiness || readiness.state === "unknown") return "unknown";
  if (readiness.dispatchPaused) return "locked";
  if (readiness.state === "blocked" || readiness.state === "locked") {
    return readiness.state === "locked" ? "locked" : "blocked";
  }
  if (!readiness.ready) return "blocked";
  if ((status.runs?.running?.length ?? 0) > 0) return "running";
  return "open";
}

export function normalizeStatus(raw: Partial<SymphonyStatus> | undefined): SymphonyStatus {
  const input = raw ?? {};
  const runs = input.runs ?? {};
  const status: SymphonyStatus = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    instance: {
      id: input.instance?.id ?? "unknown",
      label: input.instance?.label,
      pid: input.instance?.pid ?? null,
      startedAt: input.instance?.startedAt ?? null,
      endpoint: input.instance?.endpoint ?? null,
      daemonVersion: input.instance?.daemonVersion
    },
    readiness: normalizeReadiness(input.readiness),
    capabilities: asArray(input.capabilities),
    boards: asArray(input.boards),
    routes: asArray(input.routes),
    cards: asArray(input.cards),
    runs: {
      ...emptyRunBuckets(),
      queued: asArray(runs.queued),
      running: asArray(runs.running),
      completed: asArray(runs.completed),
      failed: asArray(runs.failed),
      cancelled: asArray(runs.cancelled),
      preempted: asArray(runs.preempted)
    },
    claims: asArray(input.claims),
    worktrees: asArray(input.worktrees),
    retryQueue: asArray(input.retryQueue),
    capacityRefusals: asArray(input.capacityRefusals),
    doctor: {
      goalClosable: input.doctor?.goalClosable ?? true,
      blockers: asArray(input.doctor?.blockers),
      checkedAt: input.doctor?.checkedAt
    },
    warnings: asArray(input.warnings),
    recentEvents: asArray(input.recentEvents),
    lastUpdatedAt: input.lastUpdatedAt ?? new Date(0).toISOString()
  };
  return status;
}

// Convenience selectors used by the cockpit model and CLI text output.
export function countDirtyWorktrees(status: SymphonyStatus): number {
  return status.worktrees.filter((worktree) => worktree.dirty).length;
}

export function countPreservedWorktrees(status: SymphonyStatus): number {
  return status.worktrees.filter((worktree) => worktree.preserved).length;
}
