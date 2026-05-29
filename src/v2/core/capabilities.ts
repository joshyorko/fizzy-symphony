// Capability registry: the project's memory of what it can do.
//
// The cockpit help/manual screen and the `capabilities` command are generated
// from this registry rather than from hardcoded stale text. Capabilities are
// derived against a status snapshot so disabled reasons reflect live state.

import type {
  Capability,
  SymphonyStatus
} from "./types.ts";

// Static catalogue of v2 capabilities. `enabled` here is the baseline; the
// derive step below can flip a capability to disabled with a reason based on
// the current status snapshot.
const CATALOGUE: Capability[] = [
  {
    id: "fizzy.boards",
    title: "List Fizzy boards & routes",
    category: "fizzy",
    description: "Discover boards, columns, and golden cards through the FizzyPort adapter (SDK or HTTP).",
    enabled: true,
    commands: [],
    endpoints: ["GET /v2/status"],
    stateFields: ["boards", "routes"]
  },
  {
    id: "route.golden",
    title: "Golden-card routing",
    category: "route",
    description: "Golden cards define automation routes per board column.",
    enabled: true,
    stateFields: ["routes", "cards"]
  },
  {
    id: "codex.run",
    title: "Run Codex turns",
    category: "codex",
    description: "Dispatch Codex agent turns for active cards behind the CodexRunnerPort.",
    enabled: true,
    stateFields: ["runs"],
    risks: ["Spawns agent processes that modify worktrees"]
  },
  {
    id: "codex.cancel",
    title: "Cancel a running turn",
    category: "runner",
    description: "Interrupt an in-flight Codex turn for the selected run.",
    enabled: true,
    commands: ["run.cancel"],
    endpoints: ["POST /v2/commands"],
    stateFields: ["runs.running"],
    risks: ["Aborts in-progress agent work"]
  },
  {
    id: "session.stop",
    title: "Stop a Codex session",
    category: "runner",
    description: "Unsubscribe and stop a Codex session for the selected run.",
    enabled: true,
    commands: ["session.stop"],
    endpoints: ["POST /v2/commands"]
  },
  {
    id: "control.dispatch",
    title: "Pause / resume dispatch",
    category: "control",
    description: "Operator control over whether the daemon dispatches new turns.",
    enabled: true,
    commands: ["dispatch.pause", "dispatch.resume"],
    endpoints: ["POST /v2/commands"]
  },
  {
    id: "card.rerun",
    title: "Request a card rerun",
    category: "route",
    description: "Re-dispatch automation for a card that already ran.",
    enabled: true,
    commands: ["card.rerun"],
    endpoints: ["POST /v2/commands"]
  },
  {
    id: "card.move",
    title: "Move a card",
    category: "fizzy",
    description: "Move a card to another column through the Fizzy moveCard adapter.",
    enabled: true,
    commands: ["card.move"],
    endpoints: ["POST /v2/commands"],
    risks: ["Mutates the Fizzy board"]
  },
  {
    id: "worktree.inspect",
    title: "Inspect worktrees",
    category: "worktree",
    description: "Surface dirty worktrees, preserved workspaces, branch, and last error.",
    enabled: true,
    endpoints: ["GET /v2/worktrees"],
    stateFields: ["worktrees"]
  },
  {
    id: "worktree.preserve",
    title: "Preserve / cleanup worktree",
    category: "worktree",
    description: "Keep or clean a Symphony worktree after triage.",
    enabled: true,
    commands: ["worktree.preserve", "worktree.cleanup"],
    endpoints: ["POST /v2/commands"],
    risks: ["cleanup discards local worktree state"]
  },
  {
    id: "doctor.goal",
    title: "Goal-closing doctor",
    category: "doctor",
    description: "Block goal closure while dirty worktrees or untriaged failures remain.",
    enabled: true,
    stateFields: ["doctor", "worktrees"]
  },
  {
    id: "runner.health",
    title: "Runner health monitoring",
    category: "runner",
    description: "Track Codex runner availability and gate dispatch readiness.",
    enabled: true,
    stateFields: ["readiness", "runs"]
  },
  {
    id: "webhook.filter",
    title: "Webhook filtering",
    category: "webhook",
    description: "Filter Fizzy webhook events by freshness and self-event suppression.",
    enabled: true,
    stateFields: ["warnings"]
  },
  {
    id: "diagnostics.events",
    title: "Runtime event log",
    category: "diagnostics",
    description: "Recent completions, failures, warnings, and capacity refusals.",
    enabled: true,
    endpoints: ["GET /v2/events"],
    stateFields: ["recentEvents", "warnings", "capacityRefusals"]
  }
];

export function listCapabilities(): Capability[] {
  return CATALOGUE.map((capability) => ({ ...capability }));
}

export function getCapability(id: string): Capability | undefined {
  const found = CATALOGUE.find((capability) => capability.id === id);
  return found ? { ...found } : undefined;
}

// Derive capabilities against a live status snapshot. This is pure: it never
// mutates the input and returns fresh objects.
export function deriveCapabilities(status: SymphonyStatus): Capability[] {
  const runningCount = status.runs?.running?.length ?? 0;
  const dispatchPaused = status.readiness?.dispatchPaused === true;
  const runnerReady = status.readiness?.runnerStatus === "ready";

  return CATALOGUE.map((capability) => {
    const next: Capability = { ...capability };
    switch (capability.id) {
      case "codex.cancel":
      case "session.stop":
        if (runningCount === 0) {
          next.enabled = false;
          next.disabledReason = "No active run";
        }
        break;
      case "codex.run":
        if (!runnerReady) {
          next.enabled = false;
          next.disabledReason = "Runner not ready";
        }
        break;
      case "control.dispatch":
        next.disabledReason = dispatchPaused ? "Dispatch already paused" : undefined;
        break;
      default:
        break;
    }
    return next;
  });
}
