// Cockpit text renderer.
//
// renderCockpitText turns a CockpitModel into a single, deliberate operator
// cockpit screen. It is pure (model in, string out) and is used for:
//   - non-TTY fallback
//   - `cockpit --once`
//   - the body of the interactive renderer's live frames
//
// The interactive Terminal Kit renderer lives in ./interactive.ts and reuses
// this text. Truth-first: raw IDs, paths, mode, endpoint, readiness and
// disabled reasons always accompany the Wonka/factory flavor labels.
//
// Layout (one strong screen, no nested cards):
//   header rail → attention strip → counts rail → section rail →
//   primary section (mode-honest) → inspector (selection + actions + guidance)
//   → command palette (when open) → footer.

import {
  GLYPH,
  clampWidth,
  createPainter,
  fitVisible,
  frameRule,
  headingRule,
  justify,
  padEndVisible,
  stripAnsi,
  truncateMiddle,
  visibleWidth,
  type Painter,
  type Tone
} from "./format.ts";
import { FACTORY_STATE_LABELS, worktreeThemeLabel } from "./theme.ts";
import type {
  CardRuntimeState,
  CockpitMode,
  CockpitModel,
  RunState
} from "../core/types.ts";

export interface RenderOptions {
  color?: boolean;
  width?: number;
}

const MODE_TONE: Record<CockpitMode, Tone> = {
  DEMO: "magenta",
  LIVE: "green",
  OFFLINE: "yellow",
  SETUP: "cyan"
};

function stateTone(state: CardRuntimeState | RunState): Tone {
  switch (state) {
    case "running":
      return "blue";
    case "queued":
      return "cyan";
    case "completed":
      return "green";
    case "failed":
    case "blocked":
      return "red";
    case "preempted":
      return "yellow";
    default:
      return "dim";
  }
}

// Honest, mode-aware status for a live operator action (one with a commandType).
// A fixture is not a daemon and SETUP/OFFLINE have no reachable daemon, so a
// mutating action can never read a live "ready" in those modes — it reads as a
// disabled state with an explicit reason. DEMO is doubly enforced: the
// interactive layer also refuses to dispatch (see interactive.ts submit()), so
// fixture data can never masquerade as a fire-ready live mutation.
function operatorActionStatus(
  mode: CockpitMode,
  enabled: boolean,
  mutating: boolean,
  disabledReason: string | undefined,
  c: Painter
): string {
  if (mutating) {
    if (mode === "DEMO") return c.tint("magenta", `demo ${GLYPH.dot} fixture data, not a live daemon`);
    if (mode === "SETUP") return c.faint(`off ${GLYPH.dot} No daemon yet — run setup first.`);
    if (mode === "OFFLINE") return c.faint(`off ${GLYPH.dot} Daemon offline — start it to act.`);
  }
  return enabled
    ? c.tint("green", "ready")
    : c.faint(`off ${GLYPH.dot} ${disabledReason ?? "unavailable"}`);
}

// ---------------------------------------------------------------------------
// Header rail
// ---------------------------------------------------------------------------

function renderHeader(model: CockpitModel, c: Painter, width: number): string[] {
  const mode = model.app.mode;
  const badge = c.tint(MODE_TONE[mode], `[ ${mode} ]`, true);
  const badgeWidth = visibleWidth(badge);

  // Keep the mode badge whole (it is the most safety-critical glance); trim the
  // wordmark first, then drop the subtitle, so the badge always survives.
  let wordmark = `${c.bold("FIZZY-SYMPHONY")} ${c.faint(GLYPH.lane)} ${c.dim("operator cockpit")}`;
  const wordmarkBudget = width - badgeWidth - 3;
  if (visibleWidth(wordmark) > wordmarkBudget) {
    wordmark = c.bold("FIZZY-SYMPHONY");
    if (visibleWidth(wordmark) > wordmarkBudget) {
      wordmark = fitVisible(wordmark, Math.max(3, wordmarkBudget));
    }
  }

  const readiness = c.tint(
    model.header.readiness === "ready" ? "green" : model.header.readiness === "unknown" ? "dim" : "yellow",
    model.header.readiness
  );
  const factory = c.dim(FACTORY_STATE_LABELS[model.factoryState]);
  const runner = `runner ${c.dim(model.header.runnerStatus ?? "unknown")}`;
  const metaLeft = ` readiness ${readiness} ${c.faint(GLYPH.dot)} ${factory} ${c.faint(GLYPH.dot)} ${runner}`;

  const connection = renderConnection(model, c, width);
  const configPath = truncateMiddle(model.app.configPath, Math.max(10, width - 10));

  return [
    frameRule(width, c),
    fitVisible(justify(` ${wordmark}`, `${badge} `, width), width),
    fitVisible(metaLeft, width),
    fitVisible(` ${connection}`, width),
    fitVisible(` ${c.faint("config")}  ${c.dim(configPath)}`, width),
    frameRule(width, c)
  ];
}

// Mode-honest connection line. DEMO never claims a live daemon: it shows the
// fixture source (app.source) so an embedded fixture endpoint is not mistaken
// for a reachable daemon. LIVE shows the real endpoint; OFFLINE/SETUP say so.
function renderConnection(model: CockpitModel, c: Painter, width: number): string {
  switch (model.app.mode) {
    case "LIVE": {
      const endpoint = String(model.app.endpoint ?? model.header.endpoint ?? "connected");
      const shown = truncateMiddle(endpoint, Math.max(12, width - 12));
      return `daemon ${c.tint("green", "●")} ${c.dim(shown)}`;
    }
    case "DEMO": {
      const prefix = `source ${c.tint("magenta", GLYPH.offline)} ${c.faint("(demo data)")} `;
      const source = truncateMiddle(model.app.source, Math.max(8, width - 1 - visibleWidth(prefix)));
      return `${prefix}${c.dim(source)}`;
    }
    case "OFFLINE": {
      const source = truncateMiddle(model.app.source, Math.max(12, width - 22));
      return `daemon ${c.tint("yellow", GLYPH.err)} ${c.tint("yellow", "offline")} ${c.faint(GLYPH.dot)} ${c.dim(source)}`;
    }
    case "SETUP":
    default:
      return `daemon ${c.faint(GLYPH.dot)} ${c.dim("not configured")}`;
  }
}

// ---------------------------------------------------------------------------
// Attention strip — the single highest-priority fact + next safe move.
// ---------------------------------------------------------------------------

interface Attention {
  tone: Tone;
  glyph: string;
  text: string;
}

function computeAttention(model: CockpitModel): Attention {
  const counts = model.header.counts;
  const mode = model.app.mode;

  if (mode === "SETUP") {
    return {
      tone: "cyan",
      glyph: GLYPH.setup,
      text: "Setup needed — no config yet. Run the setup wizard to wire boards, routes, and the runner."
    };
  }
  if (mode === "OFFLINE") {
    return {
      tone: "yellow",
      glyph: GLYPH.offline,
      text: "Daemon offline — config found but no reachable daemon. Start the daemon to operate."
    };
  }

  const cannotClose = model.factoryState === "blocked" || model.panels.doctor.goalClosable === false;
  if (cannotClose) {
    const n = model.panels.doctor.blockers.length;
    const detail = n > 0 ? `${n} blocker${n === 1 ? "" : "s"}` : "runner unavailable";
    return {
      tone: "red",
      glyph: GLYPH.err,
      text: `Factory cannot close — ${detail}. Open Doctor (d).`
    };
  }

  if (counts.failed > 0) {
    const failed = model.panels.activeRuns.find((run) => run.state === "failed");
    const code = failed?.error?.code ?? "FAILED";
    return {
      tone: "red",
      glyph: GLYPH.err,
      text: `${counts.failed} run${counts.failed === 1 ? "" : "s"} failed — ${code}. Open Runs (2).`
    };
  }

  if (counts.dirtyWorktrees > 0) {
    return {
      tone: "yellow",
      glyph: GLYPH.warn,
      text: `${counts.dirtyWorktrees} worktree${counts.dirtyWorktrees === 1 ? "" : "s"} dirty — ${worktreeThemeLabel(true, false)}. Open Worktrees (w).`
    };
  }

  if (model.factoryState === "locked") {
    return {
      tone: "yellow",
      glyph: GLYPH.warn,
      text: "Factory locked — dispatch paused. Resume (u) to dispatch again."
    };
  }

  if (counts.warnings > 0) {
    return {
      tone: "yellow",
      glyph: GLYPH.warn,
      text: `${counts.warnings} warning${counts.warnings === 1 ? "" : "s"} active. Open Events (e).`
    };
  }

  if (counts.running > 0 || counts.queued > 0) {
    return {
      tone: "blue",
      glyph: GLYPH.info,
      text: `${counts.running} machine${counts.running === 1 ? "" : "s"} in motion${counts.queued > 0 ? `, ${counts.queued} queued` : ""}. Factory humming.`
    };
  }

  return {
    tone: "green",
    glyph: GLYPH.ok,
    text: "Factory open — runner ready, nothing needs attention."
  };
}

function renderAttention(model: CockpitModel, c: Painter, width: number): string[] {
  const a = computeAttention(model);
  const bar = c.tint(a.tone, GLYPH.bar);
  const glyph = c.tint(a.tone, a.glyph, true);
  return [fitVisible(`${bar} ${glyph} ${c.tint(a.tone, a.text, true)}`, width)];
}

// ---------------------------------------------------------------------------
// Counts rail
// ---------------------------------------------------------------------------

function renderCounts(model: CockpitModel, c: Painter, width: number): string[] {
  const k = model.header.counts;
  const cell = (label: string, value: number, tone: Tone | null): string => {
    const v = tone && value > 0 ? c.tint(tone, String(value), true) : c.bold(String(value));
    return `${c.faint(label)} ${v}`;
  };
  const cells = [
    cell("boards", k.boards, null),
    cell("routes", k.routes, null),
    cell("running", k.running, "blue"),
    cell("queued", k.queued, "cyan"),
    cell("failed", k.failed, "red"),
    cell("dirty", k.dirtyWorktrees, "yellow"),
    cell("warn", k.warnings, "yellow")
  ];
  return [fitVisible(` ${cells.join("   ")}`, width)];
}

// ---------------------------------------------------------------------------
// Section rail (navigation)
// ---------------------------------------------------------------------------

function renderSectionRail(model: CockpitModel, c: Painter, width: number): string[] {
  const tabs = model.sections.map((section) => {
    const active = section.id === model.selectedSectionId;
    const key = c.faint(section.key);
    if (active) {
      return `${c.tint("blue", GLYPH.sel, true)} ${c.tint("blue", section.label, true)} ${key}`;
    }
    return `${c.dim(section.label)} ${key}`;
  });
  return [fitVisible(` ${c.faint("sections")}  ${tabs.join(c.faint(`  ${GLYPH.dot} `))}`, width)];
}

// ---------------------------------------------------------------------------
// Primary section
// ---------------------------------------------------------------------------

function renderPrimary(model: CockpitModel, c: Painter, width: number): string[] {
  if (model.app.mode === "SETUP") return renderSetupScreen(model, c, width);
  if (model.app.mode === "OFFLINE") return renderOfflineScreen(model, c, width);
  return renderSection(model, c, width);
}

function renderSetupScreen(model: CockpitModel, c: Painter, width: number): string[] {
  return [
    headingRule("Getting started", width, c),
    `   ${c.tint("cyan", "1", true)}  Run the setup wizard to create config and wire your runner.`,
    `   ${c.tint("cyan", "2", true)}  Start the daemon, then re-open the cockpit to operate live.`,
    `   ${c.dim("No boards, routes, or runs exist yet — nothing here is live.")}`,
    `   ${c.faint("config target")}  ${c.dim(truncateMiddle(model.app.configPath, Math.max(10, width - 18)))}`
  ];
}

function renderOfflineScreen(model: CockpitModel, c: Painter, width: number): string[] {
  return [
    headingRule("Daemon offline", width, c),
    `   ${c.faint("config")}  ${c.dim(truncateMiddle(model.app.configPath, Math.max(10, width - 12)))}`,
    `   ${c.dim("Boards, routes, runs, and worktrees stay hidden until a daemon is")}`,
    `   ${c.dim("reachable. Live actions are unavailable while offline.")}`,
    `   ${c.tint("yellow", "Start the daemon, then refresh (r).", true)}`
  ];
}

function renderSection(model: CockpitModel, c: Painter, width: number): string[] {
  switch (model.selectedSectionId) {
    case "runs":
      return renderRuns(model, c, width);
    case "worktrees":
      return renderWorktrees(model, c, width);
    case "doctor":
      return renderDoctor(model, c, width);
    case "manual":
      return renderManual(model, c, width);
    case "events":
      return renderEvents(model, c, width);
    case "settings":
      return renderSettings(model, c, width);
    case "advanced":
      return renderAdvanced(model, c, width);
    case "factory":
    default:
      return renderFactory(model, c, width);
  }
}

function renderFactory(model: CockpitModel, c: Painter, width: number): string[] {
  const lines = [headingRule("Factory lanes", width, c)];
  if (model.lanes.length === 0) {
    lines.push(`   ${c.dim("(no routes configured)")}`);
    return lines;
  }
  for (const lane of model.lanes) {
    const meta = c.faint(`route ${lane.routeId} ${GLYPH.dot} board ${lane.boardId}`);
    let title = c.tint("white", lane.title, true);
    if (!lane.enabled) {
      title += ` ${c.tint("red", `[disabled: ${lane.disabledReason ?? "unknown"}]`)}`;
    }
    lines.push(justify(`  ${title}`, `${meta} `, width));
    if (lane.cards.length === 0) {
      lines.push(`     ${c.dim("(no cards on this line)")}`);
      continue;
    }
    for (const card of lane.cards) {
      const num = card.number !== undefined ? `#${card.number}` : "—";
      const hazard = card.hazard ? ` ${c.tint("red", "⚠", true)}` : "";
      const state = c.tint(stateTone(card.state), card.state);
      const ids = c.faint(`card ${card.id}${card.runId ? ` ${GLYPH.dot} run ${card.runId}` : ""}`);
      lines.push(
        `     ${c.faint(GLYPH.bullet)} ${c.bold(padEndVisible(num, 5))} ${card.title}${hazard}` +
          `  ${state} ${c.faint(GLYPH.dot)} ${c.dim(card.themeLabel)}  ${ids}`
      );
      if (card.attention) lines.push(`         ${c.tint("yellow", `attention: ${card.attention}`)}`);
    }
  }
  return lines;
}

function renderRuns(model: CockpitModel, c: Painter, width: number): string[] {
  const lines = [headingRule("Runs", width, c)];
  if (model.panels.activeRuns.length === 0) {
    lines.push(`   ${c.dim("(no active or queued runs)")}`);
    return lines;
  }
  for (const run of model.panels.activeRuns) {
    const state = c.tint(stateTone(run.state), run.state);
    const stall = run.stalled ? ` ${c.tint("yellow", "[stalled]", true)}` : "";
    const card = run.cardNumber !== undefined ? c.faint(`card #${run.cardNumber}`) : c.faint("card —");
    lines.push(
      `   ${c.faint(GLYPH.bullet)} ${c.bold(run.id)}  ${state}${stall}  ${card} ${c.faint(GLYPH.dot)} ${c.dim(run.themeLabel)}`
    );
    if (run.error) lines.push(`       ${c.tint("red", `${run.error.code}: ${run.error.message}`)}`);
  }
  return lines;
}

function renderWorktrees(model: CockpitModel, c: Painter, width: number): string[] {
  const lines = [headingRule("Worktrees", width, c)];
  if (model.panels.worktrees.length === 0) {
    lines.push(`   ${c.dim("(no worktrees)")}`);
    return lines;
  }
  for (const wt of model.panels.worktrees) {
    const flags = [wt.dirty ? "dirty" : null, wt.preserved ? "preserved" : null].filter(Boolean).join(",") || "clean";
    const flagTone: Tone = wt.dirty ? "yellow" : wt.preserved ? "cyan" : "green";
    lines.push(
      `   ${c.faint(GLYPH.bullet)} ${c.bold(wt.workspaceKey)}  ${c.tint(flagTone, flags)} ${c.faint(GLYPH.dot)} ${c.dim(wt.themeLabel)}`
    );
    lines.push(`       ${c.faint(truncateMiddle(wt.path, Math.max(12, width - 7)))}`);
    if (wt.recommendedAction) lines.push(`       ${c.tint("yellow", `action: ${wt.recommendedAction}`)}`);
  }
  return lines;
}

function renderDoctor(model: CockpitModel, c: Painter, width: number): string[] {
  const doctor = model.panels.doctor;
  const tone: Tone = doctor.goalClosable ? "green" : "red";
  const lines = [
    headingRule("Doctor", width, c),
    `   ${c.tint(tone, doctor.themeLabel, true)} ${c.faint(`(goalClosable=${doctor.goalClosable})`)}`
  ];
  if (doctor.blockers.length === 0) {
    lines.push(`   ${c.dim("no blockers")}`);
    return lines;
  }
  for (const blocker of doctor.blockers) {
    const where = blocker.workspaceKey ? c.faint(` [${blocker.workspaceKey}]`) : "";
    lines.push(`   ${c.tint("red", GLYPH.err)} ${c.bold(blocker.code)}: ${blocker.message}${where}`);
    if (blocker.recommendedAction) lines.push(`       ${c.tint("yellow", `action: ${blocker.recommendedAction}`)}`);
  }
  return lines;
}

function renderManual(model: CockpitModel, c: Painter, width: number): string[] {
  const lines = [headingRule("Factory Manual", width, c), `   ${c.bold(model.help.manualTitle)}`];
  for (const capability of model.help.capabilities.slice(0, 12)) {
    const state = capability.enabled ? c.tint("green", "enabled") : c.faint(`disabled: ${capability.disabledReason ?? "n/a"}`);
    lines.push(`   ${c.faint(`[${capability.category}]`)} ${c.dim(capability.id)} — ${capability.title}  ${state}`);
  }
  return lines;
}

function renderEvents(model: CockpitModel, c: Painter, width: number): string[] {
  const lines = [headingRule("Events", width, c)];
  if (model.panels.events.length === 0) {
    lines.push(`   ${c.dim("(no events)")}`);
    return lines;
  }
  // Severity carries a distinct glyph (not color alone) so info/warning/error
  // stay distinguishable under NO_COLOR / monochrome terminals, matching the
  // attention strip and doctor markers.
  const mark = (sev: string): { tone: Tone; glyph: string } =>
    sev === "error"
      ? { tone: "red", glyph: GLYPH.err }
      : sev === "warning"
        ? { tone: "yellow", glyph: GLYPH.warn }
        : { tone: "blue", glyph: GLYPH.info };
  for (const event of model.panels.events.slice(0, 12)) {
    const m = mark(event.severity);
    lines.push(
      `   ${c.tint(m.tone, m.glyph)} ${c.faint(event.at)}  ${c.dim(event.themeLabel)}  ${event.message}`
    );
  }
  return lines;
}

function renderSettings(model: CockpitModel, c: Painter, width: number): string[] {
  const s = model.settings;
  const rows: Array<[string, string]> = [
    ["mode", s.mode],
    ["source", s.source],
    ["config", s.configPath],
    ["endpoint", s.endpoint ? String(s.endpoint) : "—"],
    ["readiness", `${s.readiness} (${s.readinessBlockers} blocker(s))`],
    ["runner", s.runnerStatus ?? "unknown"],
    ["boards / routes", `${s.boardCount} / ${s.routeCount}`],
    ["worktrees", `${s.workspaceCount} total, ${s.dirtyWorktrees} dirty`],
    ["live endpoint", String(s.hasLiveEndpoint)]
  ];
  const keyWidth = Math.max(...rows.map(([key]) => key.length));
  const valueBudget = Math.max(12, width - 5 - keyWidth);
  const lines = [headingRule("Settings", width, c)];
  for (const [key, value] of rows) {
    lines.push(`   ${c.faint(padEndVisible(key, keyWidth))}  ${c.dim(truncateMiddle(value, valueBudget))}`);
  }
  return lines;
}

function renderAdvanced(model: CockpitModel, c: Painter, width: number): string[] {
  const lines = [headingRule("Advanced commands", width, c)];
  for (const command of model.advancedCommands) {
    const state = command.enabled
      ? c.tint("green", "enabled")
      : c.faint(`disabled: ${command.disabledReason ?? "n/a"}`);
    const mutates = command.mutates ? c.tint("magenta", "↯ mutates") : c.faint("read-only");
    lines.push(`   ${c.bold(`[${command.key}]`)} ${c.dim(command.label)}  ${mutates} ${c.faint(GLYPH.dot)} ${state}`);
    lines.push(`       ${c.faint(`${GLYPH.prompt} ${command.command}`)}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Inspector: selection raw truth + actions + guidance commands.
// ---------------------------------------------------------------------------

function renderInspector(model: CockpitModel, c: Painter, width: number): string[] {
  const lines: string[] = [];
  lines.push(...renderSelection(model, c, width));
  lines.push("");
  lines.push(...renderActions(model, c, width));
  const guidance = renderGuidance(model, c, width);
  if (guidance.length > 0) {
    lines.push("");
    lines.push(...guidance);
  }
  return lines;
}

function renderSelection(model: CockpitModel, c: Painter, width: number): string[] {
  const selection = model.selected;
  if (!selection || selection.kind === "none") {
    return [
      headingRule("Inspect", width, c),
      `   ${c.dim("nothing selected — use ↑/↓ to choose a card, run, or worktree, then Enter.")}`
    ];
  }
  const lines = [
    headingRule("Inspect", width, c),
    `   ${c.bold(truncateMiddle(`${selection.kind} ${selection.id ?? ""}`.trim(), Math.max(8, width - 4)))}  ${c.dim(selection.themeLabel ?? "")}`
  ];
  const entries = Object.entries(selection.raw).filter(([, value]) => value !== undefined && value !== null);
  const keyWidth = Math.max(0, ...entries.map(([key]) => key.length));
  // Raw values (paths, ids, error JSON) are the truth-first payload: keep both
  // ends legible with a middle ellipsis rather than clipping the tail.
  const valueBudget = Math.max(12, width - 5 - keyWidth);
  for (const [key, value] of entries) {
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    lines.push(`   ${c.faint(padEndVisible(key, keyWidth))}  ${c.dim(truncateMiddle(text, valueBudget))}`);
  }
  if (selection.recommendedAction) {
    lines.push(`   ${c.tint("yellow", `recommendedAction: ${selection.recommendedAction}`)}`);
  }
  return lines;
}

function renderActions(model: CockpitModel, c: Painter, width: number): string[] {
  const mode = model.app.mode;
  const lines = [
    headingRule("Actions", width, c),
    `   ${c.faint(`${GLYPH.dot} ↯ marks actions that mutate live state`)}`
  ];
  for (const action of model.actions) {
    const key = c.bold(`[${action.key ?? "?"}]`);
    const mutating = Boolean(action.commandType);
    const mutates = mutating ? c.tint("magenta", "↯") : " ";
    // operatorActionStatus enforces mode honesty: mutating actions never read
    // "ready" in DEMO/SETUP/OFFLINE — only LIVE can.
    const status = operatorActionStatus(mode, action.enabled, mutating, action.disabledReason, c);
    lines.push(fitVisible(`   ${key} ${mutates} ${padEndVisible(action.label, 34)} ${status}`, width));
  }
  return lines;
}

function renderGuidance(model: CockpitModel, c: Painter, width: number): string[] {
  const mode = model.app.mode;
  if (mode !== "SETUP" && mode !== "OFFLINE" && mode !== "DEMO") return [];

  const rows: Array<{ label: string; command: string }> = model.nextActions.map((action) => ({
    label: action.label,
    command: action.command
  }));

  if (mode === "OFFLINE") {
    for (const id of ["status", "doctor", "dashboard"]) {
      const command = model.advancedCommands.find((entry) => entry.id === id);
      if (command) rows.push({ label: command.label, command: command.command });
    }
  }

  if (rows.length === 0) return [];

  const lines = [
    headingRule("Next in your shell", width, c),
    `   ${c.faint("guidance only — these are not run for you")}`
  ];
  for (const row of rows) {
    lines.push(`   ${c.tint("green", GLYPH.prompt)} ${c.dim(row.command)}`);
    lines.push(`       ${c.faint(row.label)}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

function renderCommandPalette(model: CockpitModel, c: Painter, width: number): string[] {
  if (!model.commandPaletteOpen) return [];
  const mode = model.app.mode;
  const sections = model.commandPalette.filter((row) => row.section);
  const actions = model.commandPalette.filter((row) => row.id.startsWith("action."));
  const commands = model.commandPalette.filter((row) => row.id.startsWith("advanced."));

  const lines = [
    headingRule("Command palette", width, c),
    // Legend: explain the prefix convention so the keys read as a real menu,
    // not a printed list of codes. Kept short enough to survive an 80-col clamp.
    fitVisible(
      `   ${c.faint(`A:key action ${GLYPH.dot} V:key command ${GLYPH.dot} number/letter jumps ${GLYPH.dot} Esc closes`)}`,
      width
    )
  ];

  lines.push(
    fitVisible(
      `   ${c.faint("sections")}  ${sections
        .map((row) => `${c.bold(`[${row.key}]`)} ${c.dim(row.label.replace(/^Open | section$/gu, ""))}`)
        .join(c.faint(`  ${GLYPH.dot} `))}`,
      width
    )
  );

  const keyWidth = Math.max(0, ...[...actions, ...commands].map((row) => row.key.length));

  lines.push(`   ${c.faint("actions")}`);
  for (const row of actions) {
    const status = operatorActionStatus(mode, row.enabled, row.mutates, row.disabledReason, c);
    const meta = row.mutates ? c.tint("magenta", "↯") : c.faint("ro");
    lines.push(
      fitVisible(`     ${c.bold(padEndVisible(row.key, keyWidth))} ${meta} ${padEndVisible(row.label, 30)} ${status}`, width)
    );
  }

  lines.push(`   ${c.faint("commands")}`);
  for (const row of commands) {
    // Advanced commands are shell-command hints, not live daemon actions, so
    // their availability is their own (e.g. dashboard needs a live endpoint);
    // mode honesty for live mutations does not apply here.
    const status = row.enabled
      ? c.tint("green", "ready")
      : c.faint(`off ${GLYPH.dot} ${row.disabledReason ?? "unavailable"}`);
    const meta = row.mutates ? c.tint("magenta", "↯") : c.faint("ro");
    const backing = row.endpoint ?? row.command ?? "";
    lines.push(
      fitVisible(`     ${c.bold(padEndVisible(row.key, keyWidth))} ${meta} ${padEndVisible(row.label, 22)} ${status}`, width)
    );
    if (backing) {
      lines.push(fitVisible(`         ${c.faint(truncateMiddle(String(backing), Math.max(12, width - 9)))}`, width));
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function renderFooter(c: Painter, width: number): string[] {
  const hints = [
    "↑↓ navigate",
    "Enter inspect",
    "/ filter",
    "⌃P palette",
    "? manual",
    "r refresh",
    "q quit"
  ];
  return [frameRule(width, c), ` ${c.dim(hints.join(c.faint(`  ${GLYPH.dot} `)))}`];
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

// A copyable command line (its visible content begins with the "$ " prompt).
// These are meant to be pasted into a shell, so they are exempt from the width
// clamp: a middle ellipsis would corrupt the command. They wrap instead.
function isCopyableCommand(line: string): boolean {
  return stripAnsi(line).trimStart().startsWith(`${GLYPH.prompt} `);
}

// Final hard guarantee: no rendered line overruns the frame at any width. Long
// in-cell content is already middle-truncated where it matters (paths, ids,
// values); this catches everything else (lane cards, runs, events, doctor,
// manual, footer) without each renderer having to clamp by hand. Copyable
// command lines are preserved verbatim.
function clampLines(lines: string[], width: number): string[] {
  return lines.map((line) => (isCopyableCommand(line) ? line : fitVisible(line, width)));
}

export function renderCockpitText(model: CockpitModel, options: RenderOptions = {}): string {
  const c = createPainter(options.color === true);
  const width = clampWidth(options.width);

  const lines: string[] = [];
  lines.push(...renderHeader(model, c, width));
  lines.push(...renderAttention(model, c, width));
  lines.push(...renderCounts(model, c, width));
  lines.push("");
  lines.push(...renderSectionRail(model, c, width));
  lines.push("");
  lines.push(...renderPrimary(model, c, width));
  lines.push("");
  lines.push(...renderInspector(model, c, width));
  const palette = renderCommandPalette(model, c, width);
  if (palette.length > 0) {
    lines.push("");
    lines.push(...palette);
  }
  lines.push("");
  lines.push(...renderFooter(c, width));

  return clampLines(lines, width).join("\n");
}

export function renderCapabilitiesText(model: CockpitModel, options: RenderOptions = {}): string {
  const c = createPainter(options.color === true);
  const width = clampWidth(options.width);
  const lines = [headingRule(model.help.manualTitle, width, c)];
  for (const capability of model.help.capabilities) {
    const state = capability.enabled
      ? c.tint("green", "enabled")
      : c.faint(`disabled: ${capability.disabledReason ?? "n/a"}`);
    lines.push(`   ${c.faint(`[${capability.category}]`)} ${c.dim(capability.id)} — ${capability.title}  ${state}`);
  }
  return lines.join("\n");
}
