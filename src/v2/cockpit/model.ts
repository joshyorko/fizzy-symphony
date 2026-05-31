// Pure cockpit model.
//
// createCockpitModel takes a status snapshot (+ events + capabilities + a
// selection + a filter) and produces a fully-derived view model for the
// renderer. It MUST be pure:
//   - no fetch, no file IO, no process spawning
//   - no calls to Fizzy or Codex
//   - no mutation of status, no command enqueueing
//
// The renderer consumes this model and draws it. The renderer never reaches
// past this model to perform work.

import {
  deriveCapabilities,
  listCapabilities
} from "../core/capabilities.ts";
import { checkCommandAvailability } from "../core/commands.ts";
import { deriveFactoryState } from "../core/status.ts";
import {
  FACTORY_STATE_LABELS,
  ROUTE_THEME_LABEL,
  cardThemeLabel,
  doctorThemeLabel,
  eventThemeLabel,
  runThemeLabel,
  worktreeThemeLabel
} from "./theme.ts";
import type {
  Capability,
  CapabilitySummary,
  CockpitAdvancedCommand,
  CockpitApp,
  CockpitMode,
  CockpitNextAction,
  CockpitPaletteRow,
  CockpitAction,
  CockpitSection,
  CockpitSectionId,
  CockpitEventSummary,
  CockpitLane,
  CockpitLaneCard,
  CockpitModel,
  CockpitModelInput,
  CockpitRunSummary,
  CockpitSelection,
  CockpitWorktreeSummary,
  OperatorCommand,
  OperatorCommandType,
  RuntimeEvent,
  SymphonyStatus
} from "../core/types.ts";

const CARD_HAZARD_STATES = new Set(["failed", "blocked"]);
const DEFAULT_SECTION_ID: CockpitSectionId = "factory";

const DEFAULT_SECTIONS: CockpitSection[] = [
  { id: "factory", label: "Factory", key: "f" },
  { id: "runs", label: "Runs", key: "2" },
  { id: "worktrees", label: "Worktrees", key: "w" },
  { id: "doctor", label: "Doctor", key: "d" },
  { id: "manual", label: "Manual", key: "m" },
  { id: "events", label: "Events", key: "e" },
  { id: "settings", label: "Settings", key: "S" },
  { id: "advanced", label: "Advanced", key: "8" }
];

function matchesFilter(text: string, filter?: string): boolean {
  if (!filter) return true;
  return text.toLowerCase().includes(filter.toLowerCase());
}

function buildLanes(status: SymphonyStatus, filter?: string): CockpitLane[] {
  return status.routes.map((route) => {
    const cards: CockpitLaneCard[] = status.cards
      .filter((card) => card.routeId === route.id)
      .filter((card) =>
        matchesFilter(`${card.title} ${card.number ?? ""} ${card.id} ${card.state}`, filter)
      )
      .map((card) => ({
        id: card.id,
        themeLabel: cardThemeLabel(card.state, card.golden),
        title: card.title,
        number: card.number,
        state: card.state,
        golden: card.golden,
        runId: card.runId,
        hazard: CARD_HAZARD_STATES.has(card.state),
        attention: card.attention
      }));

    return {
      routeId: route.id,
      boardId: route.boardId,
      title: route.name,
      themeLabel: ROUTE_THEME_LABEL,
      factoryLine: route.sourceColumnName ?? route.name,
      cards,
      enabled: route.enabled,
      disabledReason: route.disabledReason
    };
  });
}

function buildSelection(status: SymphonyStatus, selectedId?: string): CockpitSelection | undefined {
  if (!selectedId) return undefined;

  const card = status.cards.find((entry) => entry.id === selectedId);
  if (card) {
    const run = card.runId
      ? [...status.runs.running, ...status.runs.failed, ...status.runs.completed].find(
          (entry) => entry.id === card.runId
        )
      : undefined;
    return {
      kind: "card",
      id: card.id,
      themeLabel: cardThemeLabel(card.state, card.golden),
      recommendedAction: card.attention ?? run?.recommendedAction,
      raw: {
        boardId: card.boardId,
        cardId: card.id,
        cardNumber: card.number,
        routeId: card.routeId,
        columnId: card.columnId,
        columnName: card.columnName,
        state: card.state,
        runId: card.runId,
        claimId: card.claimId,
        sessionId: run?.sessionId,
        workspacePath: card.workspacePath ?? run?.workspacePath,
        status: run?.state ?? card.state,
        error: run?.error
      }
    };
  }

  const allRuns = [
    ...status.runs.running,
    ...status.runs.queued,
    ...status.runs.failed,
    ...status.runs.completed,
    ...status.runs.cancelled,
    ...status.runs.preempted
  ];
  const run = allRuns.find((entry) => entry.id === selectedId);
  if (run) {
    return {
      kind: "run",
      id: run.id,
      themeLabel: runThemeLabel(run.state, run.stalled),
      recommendedAction: run.recommendedAction,
      raw: {
        runId: run.id,
        attemptId: run.attemptId,
        boardId: run.boardId,
        cardId: run.cardId,
        cardNumber: run.cardNumber,
        routeId: run.routeId,
        claimId: run.claimId,
        sessionId: run.sessionId,
        turnId: run.turnId,
        workspacePath: run.workspacePath,
        status: run.state,
        error: run.error
      }
    };
  }

  const worktree = status.worktrees.find((entry) => entry.workspaceKey === selectedId);
  if (worktree) {
    return {
      kind: "worktree",
      id: worktree.workspaceKey,
      themeLabel: worktreeThemeLabel(worktree.dirty, worktree.preserved),
      recommendedAction: worktree.recommendedAction,
      raw: {
        workspaceKey: worktree.workspaceKey,
        workspacePath: worktree.path,
        cardId: worktree.cardId,
        cardNumber: worktree.cardNumber,
        runId: worktree.runId,
        branch: worktree.branch,
        dirty: worktree.dirty,
        preserved: worktree.preserved,
        dirtyPaths: worktree.dirtyPaths,
        error: worktree.lastError
      }
    };
  }

  const route = status.routes.find((entry) => entry.id === selectedId);
  if (route) {
    return {
      kind: "route",
      id: route.id,
      themeLabel: ROUTE_THEME_LABEL,
      raw: {
        routeId: route.id,
        boardId: route.boardId,
        sourceColumnId: route.sourceColumnId,
        goldenCardId: route.goldenCardId,
        backend: route.backend,
        model: route.model,
        enabled: route.enabled
      }
    };
  }

  return { kind: "none", raw: { selectedId } };
}

function appShell(input: CockpitModelInput["app"]): CockpitApp {
  return (
    input ?? {
      mode: "DEMO",
      source: "unknown",
      configPath: process.cwd(),
      endpoint: undefined
    }
  );
}

function nextActions(mode: CockpitMode, app: CockpitApp): CockpitNextAction[] {
  if (mode !== "SETUP" && mode !== "OFFLINE" && mode !== "DEMO") return [];
  if (mode === "SETUP") {
    return [
      {
        id: "setup",
        label: "Run setup wizard",
        command: `fizzy-symphony setup --config ${app.configPath}`,
        enabled: false,
        mutates: true,
        disabledReason: "Guidance only; run this command in your shell."
      }
    ];
  }
  return [
    {
      id: "start",
      label: mode === "OFFLINE"
        ? "Start daemon"
        : "Start daemon for demo data",
      command: `fizzy-symphony start --config ${app.configPath}`,
      enabled: false,
      mutates: true,
      disabledReason: "Guidance only; run this command in your shell."
    }
  ];
}

function settingsSummary(mode: CockpitMode, app: CockpitApp, status: SymphonyStatus) {
  const workspaceCount = status.worktrees.length;
  return {
    configPath: app.configPath,
    source: app.source,
    mode,
    endpoint: app.endpoint,
    runnerStatus: status.readiness.runnerStatus,
    readiness: status.readiness.state,
    readinessBlockers: status.readiness.blockers.length,
    workspaceCount,
    dirtyWorktrees: status.worktrees.filter((worktree) => worktree.dirty).length,
    boardCount: status.boards.length,
    routeCount: status.routes.length,
    hasLiveEndpoint: Boolean(app.endpoint)
  };
}

function advancedCommands(input: CockpitModelInput): CockpitAdvancedCommand[] {
  const app = appShell(input.app);
  return [
    {
      id: "setup",
      key: "x",
      label: "setup",
      command: `fizzy-symphony setup --config ${app.configPath}`,
      enabled: false,
      mutates: true,
      disabledReason: "Guidance only; run this command in your shell."
    },
    {
      id: "start",
      key: "y",
      label: "start",
      command: `fizzy-symphony start --config ${app.configPath}`,
      enabled: false,
      mutates: true,
      disabledReason: "Guidance only; run this command in your shell."
    },
    {
      id: "status",
      key: "z",
      label: "status",
      command: `fizzy-symphony status --config ${app.configPath}`,
      enabled: true,
      mutates: false
    },
    {
      id: "dashboard",
      key: "q",
      label: "dashboard",
      command: app.endpoint ? `${app.endpoint}/dashboard` : `fizzy-symphony dashboard --config ${app.configPath}`,
      enabled: Boolean(app.endpoint),
      mutates: false,
      disabledReason: app.endpoint ? undefined : "No live endpoint connected."
    },
    {
      id: "capabilities",
      key: "c",
      label: "capabilities",
      command: `fizzy-symphony capabilities --config ${app.configPath}`,
      enabled: true,
      mutates: false
    },
    {
      id: "worktrees",
      key: "t",
      label: "worktrees",
      command: `fizzy-symphony worktrees --config ${app.configPath}`,
      enabled: true,
      mutates: false
    },
    {
      id: "doctor",
      key: "D",
      label: "doctor",
      command: `fizzy-symphony doctor --goal --config ${app.configPath}`,
      enabled: true,
      mutates: false
    },
    {
      id: "cockpit-fixture",
      key: "f",
      label: "cockpit fixture",
      command: "fizzy-symphony cockpit --fixture src/v2/fixtures/ready.json --once",
      enabled: true,
      mutates: false
    }
  ];
}

function commandPaletteRows(
  input: CockpitModelInput,
  sections: CockpitSection[],
  actions: CockpitAction[]
): CockpitPaletteRow[] {
  const rows: CockpitPaletteRow[] = sections.map((section) => ({
    id: `section.${section.id}`,
    key: section.key,
    label: `Open ${section.label} section`,
    section: section.id,
    enabled: true,
    mutates: false,
    disabledReason: undefined
  }));

  for (const action of actions) {
    rows.push({
      id: `action.${action.id}`,
      key: `A:${action.key ?? "?"}`,
      label: action.label,
      enabled: action.enabled,
      disabledReason: action.disabledReason,
      mutates: Boolean(action.commandType),
      command: action.commandType
    });
  }

  for (const command of advancedCommands(input)) {
    rows.push({
      id: `advanced.${command.id}`,
      key: `V:${command.key}`,
      label: `${command.label} command`,
      enabled: command.enabled,
      disabledReason: command.disabledReason,
      mutates: command.mutates,
      endpoint: command.command
    });
  }

  return rows;
}

function activeRunSummaries(status: SymphonyStatus): CockpitRunSummary[] {
  const summaries: CockpitRunSummary[] = [];
  for (const run of [...status.runs.running, ...status.runs.queued]) {
    summaries.push({
      id: run.id,
      state: run.state,
      themeLabel: runThemeLabel(run.state, run.stalled),
      cardNumber: run.cardNumber,
      cardTitle: run.cardTitle,
      stalled: run.stalled === true,
      error: run.error
    });
  }
  for (const run of status.runs.failed) {
    summaries.push({
      id: run.id,
      state: run.state,
      themeLabel: runThemeLabel(run.state),
      cardNumber: run.cardNumber,
      cardTitle: run.cardTitle,
      stalled: false,
      error: run.error
    });
  }
  return summaries;
}

function worktreeSummaries(status: SymphonyStatus): CockpitWorktreeSummary[] {
  return status.worktrees.map((worktree) => ({
    workspaceKey: worktree.workspaceKey,
    path: worktree.path,
    dirty: worktree.dirty,
    preserved: worktree.preserved,
    themeLabel: worktreeThemeLabel(worktree.dirty, worktree.preserved),
    recommendedAction: worktree.recommendedAction
  }));
}

function eventSummaries(events: RuntimeEvent[]): CockpitEventSummary[] {
  return events.map((event) => ({
    id: event.id,
    severity: event.severity,
    message: event.message,
    at: event.at,
    themeLabel: eventThemeLabel(event.severity)
  }));
}

function capabilitySummaries(capabilities: Capability[]): CapabilitySummary[] {
  return capabilities.map((capability) => ({
    id: capability.id,
    title: capability.title,
    category: capability.category,
    enabled: capability.enabled,
    disabledReason: capability.disabledReason
  }));
}

interface ActionSpec {
  id: string;
  commandType: OperatorCommandType;
  key: string;
  label: string;
  command: (selection?: CockpitSelection) => OperatorCommand | undefined;
}

const ACTION_SPECS: ActionSpec[] = [
  {
    id: "dispatch.pause",
    commandType: "dispatch.pause",
    key: "p",
    label: "Lock factory (pause dispatch)",
    command: () => ({ type: "dispatch.pause" })
  },
  {
    id: "dispatch.resume",
    commandType: "dispatch.resume",
    key: "u",
    label: "Unlock factory (resume dispatch)",
    command: () => ({ type: "dispatch.resume" })
  },
  {
    id: "run.cancel",
    commandType: "run.cancel",
    key: "c",
    label: "Cancel selected run",
    command: (selection) =>
      selection?.raw?.runId
        ? { type: "run.cancel", runId: String(selection.raw.runId), reason: "operator cockpit" }
        : undefined
  },
  {
    id: "session.stop",
    commandType: "session.stop",
    key: "s",
    label: "Stop selected session",
    command: (selection) =>
      selection?.raw?.sessionId
        ? { type: "session.stop", sessionId: String(selection.raw.sessionId), reason: "operator cockpit" }
        : undefined
  },
  {
    id: "card.rerun",
    commandType: "card.rerun",
    key: "R",
    label: "Request rerun of selected card",
    command: (selection) =>
      selection?.kind === "card" && selection.id
        ? { type: "card.rerun", cardId: selection.id, reason: "operator cockpit" }
        : undefined
  }
];

function buildActions(status: SymphonyStatus, selection?: CockpitSelection): CockpitAction[] {
  return ACTION_SPECS.map((spec) => {
    const command = spec.command(selection);
    if (!command) {
      return {
        id: spec.id,
        commandType: spec.commandType,
        key: spec.key,
        label: spec.label,
        enabled: false,
        disabledReason: disabledSelectionReason(spec.id)
      };
    }
    const availability = checkCommandAvailability(command, status);
    return {
      id: spec.id,
      commandType: spec.commandType,
      key: spec.key,
      label: spec.label,
      enabled: availability.available,
      disabledReason: availability.available ? undefined : availability.reason
    };
  });
}

function disabledSelectionReason(actionId: string): string {
  switch (actionId) {
    case "run.cancel":
      return "No run selected";
    case "session.stop":
      return "Selected item has no active session";
    case "card.rerun":
      return "No card selected";
    default:
      return "Unavailable in current selection";
  }
}

const HELP_KEYS: Array<{ key: string; description: string }> = [
  { key: "q / Esc", description: "quit" },
  { key: "?", description: "help / Factory Manual" },
  { key: "Ctrl-P", description: "command palette" },
  { key: "r", description: "refresh" },
  { key: "arrows / h j k l", description: "navigate" },
  { key: "/", description: "filter" },
  { key: "Enter", description: "inspect selected item" },
  { key: "a", description: "available actions" },
  { key: "d", description: "doctor panel" },
  { key: "w", description: "worktrees panel" },
  { key: "l", description: "event / activity panel" },
  { key: "p", description: "pause dispatch (if available)" },
  { key: "u", description: "resume dispatch (if available)" },
  { key: "c", description: "cancel selected run (if available)" },
  { key: "s", description: "stop selected session (if available)" },
  { key: "R", description: "request rerun (if available)" },
  { key: "m", description: "move selected card (if available)" },
  { key: "1 / f", description: "factory section" },
  { key: "2", description: "runs section" },
  { key: "3 / w", description: "worktrees section" },
  { key: "4 / d", description: "doctor section" },
  { key: "5 / m", description: "manual section" },
  { key: "6 / e", description: "events section" },
  { key: "7 / S", description: "settings section" },
  { key: "8", description: "advanced section" }
];

export function createCockpitModel(input: CockpitModelInput): CockpitModel {
  const status = input.status;
  const events = input.events ?? status.recentEvents ?? [];
  const capabilities =
    input.capabilities && input.capabilities.length > 0
      ? input.capabilities
      : status.capabilities && status.capabilities.length > 0
        ? status.capabilities
        : deriveCapabilities(status);

  const factoryState = deriveFactoryState(status);
  const lanes = buildLanes(status, input.filter);
  const selection = buildSelection(status, input.selectedId);
  const actions = buildActions(status, selection);
  const sections = input.sections && input.sections.length > 0 ? input.sections : DEFAULT_SECTIONS;
  const selectedSectionId = input.selectedSectionId ?? DEFAULT_SECTION_ID;
  const paletteOpen = input.commandPaletteOpen ?? false;
  const app = appShell(input.app);
  const mode = app.mode;

  const dirtyWorktrees = status.worktrees.filter((worktree) => worktree.dirty).length;

  const header = {
    instanceId: status.instance.id,
    instanceLabel: status.instance.label,
    endpoint: status.instance.endpoint,
    readiness: status.readiness.state,
    factoryState,
    runnerStatus: status.readiness.runnerStatus,
    lastUpdatedAt: status.lastUpdatedAt,
    counts: {
      boards: status.boards.length,
      routes: status.routes.length,
      running: status.runs.running.length,
      queued: status.runs.queued.length,
      failed: status.runs.failed.length,
      dirtyWorktrees,
      warnings: status.warnings.length
    }
  };

  return {
    app,
    sections,
    selectedSectionId,
    nextActions: nextActions(mode, app),
    settings: settingsSummary(mode, app, status),
    commandPaletteOpen: paletteOpen,
    commandPalette: commandPaletteRows(input, sections, actions),
    advancedCommands: advancedCommands(input),
    header,
    factoryState,
    lanes,
    selected: selection,
    panels: {
      activeRuns: activeRunSummaries(status),
      worktrees: worktreeSummaries(status),
      doctor: {
        goalClosable: status.doctor.goalClosable,
        themeLabel: doctorThemeLabel(status.doctor.goalClosable),
        blockers: status.doctor.blockers
      },
      events: eventSummaries(events),
      capabilities: capabilitySummaries(capabilities)
    },
    actions,
    help: {
      manualTitle: `Factory Manual — ${FACTORY_STATE_LABELS[factoryState]}`,
      keys: HELP_KEYS,
      capabilities: capabilitySummaries(
        capabilities.length > 0 ? capabilities : listCapabilities()
      )
    }
  };
}
