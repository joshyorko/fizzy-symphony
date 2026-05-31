// Cockpit text renderer.
//
// renderCockpitText turns a CockpitModel into a static, plain-text cockpit.
// It is pure (string in, string out) and is used for:
//   - non-TTY fallback
//   - `cockpit --once`
//   - the body of the interactive renderer's static frames
//
// The interactive Terminal Kit renderer lives in ./interactive.ts and reuses
// this text where helpful. Truth-first: raw IDs always accompany theme labels.

import { FACTORY_STATE_LABELS } from "./theme.ts";
import type { CockpitModel } from "../core/types.ts";

function hr(label: string): string {
  const line = "─".repeat(Math.max(0, 62 - label.length));
  return `── ${label} ${line}`;
}

function fmtCounts(counts: CockpitModel["header"]["counts"]): string {
  return [
    `boards=${counts.boards}`,
    `routes=${counts.routes}`,
    `running=${counts.running}`,
    `queued=${counts.queued}`,
    `failed=${counts.failed}`,
    `dirty=${counts.dirtyWorktrees}`,
    `warn=${counts.warnings}`
  ].join("  ");
}

function renderSectionTabs(model: CockpitModel): string[] {
  return [
    hr("SECTIONS"),
    model.sections
      .map((section) =>
        `${section.id === model.selectedSectionId ? ">" : " "} ${section.key}: ${section.label}`
      )
      .join(" | ")
  ];
}

function renderSelectedSection(model: CockpitModel): string[] {
  const sectionId = model.selectedSectionId;
  const lines: string[] = [];
  const sectionLabel = model.sections.find((entry) => entry.id === sectionId)?.label ?? sectionId;
  lines.push(hr(`SECTION: ${sectionLabel}`));

  if (sectionId === "factory") {
    lines.push(hr("FACTORY LANES"));
    if (model.lanes.length === 0) {
      lines.push("  (no routes)");
    }
    for (const lane of model.lanes) {
      const laneState = lane.enabled ? "" : `  [disabled: ${lane.disabledReason ?? "unknown"}]`;
      lines.push(`▣ ${lane.title}  «${lane.factoryLine}»  [route ${lane.routeId}]${laneState}`);
      if (lane.cards.length === 0) lines.push("  (no cards)");
      for (const card of lane.cards) {
        const hazard = card.hazard ? " ⚠" : "";
        const num = card.number !== undefined ? `#${card.number} ` : "";
        lines.push(
          `    • ${card.themeLabel}: ${num}${card.title} [${card.state}]${hazard}` +
            `  (card ${card.id}${card.runId ? `, run ${card.runId}` : ""})`
        );
        if (card.attention) lines.push(`        attention: ${card.attention}`);
      }
    }
  }

  if (sectionId === "runs") {
    lines.push(hr("RUNS"));
    if (model.panels.activeRuns.length === 0) lines.push("  (none)");
    for (const run of model.panels.activeRuns) {
      const stall = run.stalled ? " [STALLED]" : "";
      const err = run.error ? `  err=${run.error.code}: ${run.error.message}` : "";
      lines.push(
        `  ${run.themeLabel}: run ${run.id} [${run.state}]${stall}` +
          `${run.cardNumber !== undefined ? ` card #${run.cardNumber}` : ""}${err}`
      );
    }
  }

  if (sectionId === "worktrees") {
    lines.push(hr("WORKTREES"));
    if (model.panels.worktrees.length === 0) lines.push("  (no worktrees)");
    for (const worktree of model.panels.worktrees) {
      const flags = [worktree.dirty ? "dirty" : null, worktree.preserved ? "preserved" : null]
        .filter(Boolean)
        .join(",") || "clean";
      lines.push(`  ${worktree.themeLabel}: ${worktree.workspaceKey} [${flags}] ${worktree.path}`);
      if (worktree.recommendedAction) lines.push(`      action: ${worktree.recommendedAction}`);
    }
  }

  if (sectionId === "doctor") {
    lines.push(hr("DOCTOR"));
    lines.push(`goalClosable=${model.panels.doctor.goalClosable}  ${model.panels.doctor.themeLabel}`);
    for (const blocker of model.panels.doctor.blockers) {
      lines.push(`  ${blocker.code}: ${blocker.message}`);
    }
    if (model.panels.doctor.blockers.length === 0) {
      lines.push("  no doctor blockers");
    }
  }

  if (sectionId === "manual") {
    lines.push(hr("FACTORY MANUAL"));
    lines.push(model.help.manualTitle);
  }

  if (sectionId === "events") {
    lines.push(hr("EVENTS"));
    if (model.panels.events.length === 0) lines.push("  (no events)");
    for (const event of model.panels.events.slice(0, 12)) {
      lines.push(`  [${event.severity}] ${event.themeLabel}: ${event.message}  (${event.at})`);
    }
  }

  if (sectionId === "settings") {
    lines.push(hr("SETTINGS"));
    lines.push(`source: ${model.settings.source}`);
    lines.push(`configPath: ${model.settings.configPath}`);
    lines.push(`mode: ${model.settings.mode}`);
    lines.push(`endpoint: ${model.settings.endpoint ?? "—"}`);
    lines.push(`runner: ${model.settings.runnerStatus ?? "unknown"}`);
    lines.push(`readiness: ${model.settings.readiness}`);
    lines.push(`blocks: ${model.settings.readinessBlockers}`);
    lines.push(`workspace: total=${model.settings.workspaceCount}  dirty=${model.settings.dirtyWorktrees}`);
    lines.push(`boards=${model.settings.boardCount}  routes=${model.settings.routeCount}`);
    lines.push(`hasLiveEndpoint=${model.settings.hasLiveEndpoint}`);
  }

  if (sectionId === "advanced") {
    lines.push(hr("ADVANCED COMMANDS"));
    for (const command of model.advancedCommands) {
      const state = command.enabled ? "enabled" : `disabled: ${command.disabledReason ?? "n/a"}`;
      const mutates = command.mutates ? "mutates" : "read-only";
      lines.push(`  [${command.key}] ${command.label}: ${command.command} (${state}, ${mutates})`);
    }
  }

  return lines;
}

function renderLegacySummary(model: CockpitModel): string[] {
  const lines: string[] = [];
  if (model.selected) {
    lines.push(hr("SELECTED DETAIL (raw truth)"));
    lines.push(`kind: ${model.selected.kind}   theme: ${model.selected.themeLabel ?? "—"}`);
    for (const [key, value] of Object.entries(model.selected.raw)) {
      if (value === undefined || value === null) continue;
      lines.push(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
    if (model.selected.recommendedAction) {
      lines.push(`  recommendedAction: ${model.selected.recommendedAction}`);
    }
    lines.push("");
  }

  lines.push(hr("ACTIVE RUNS"));
  if (model.panels.activeRuns.length === 0) lines.push("  (none)");
  for (const run of model.panels.activeRuns) {
    const stall = run.stalled ? " [STALLED]" : "";
    const err = run.error ? `  err=${run.error.code}: ${run.error.message}` : "";
    lines.push(
      `  ${run.themeLabel}: run ${run.id} [${run.state}]${stall}` +
        `${run.cardNumber !== undefined ? ` card #${run.cardNumber}` : ""}${err}`
    );
  }

  lines.push("");
  lines.push(hr("WORKTREES / DOCTOR"));
  lines.push(`doctor: ${model.panels.doctor.themeLabel} (goalClosable=${model.panels.doctor.goalClosable})`);
  for (const blocker of model.panels.doctor.blockers) {
    lines.push(`  ✗ ${blocker.code}: ${blocker.message}${blocker.workspaceKey ? ` [${blocker.workspaceKey}]` : ""}`);
  }
  if (model.panels.worktrees.length === 0) lines.push("  (no worktrees)");
  for (const wt of model.panels.worktrees) {
    const flags = [wt.dirty ? "dirty" : null, wt.preserved ? "preserved" : null].filter(Boolean).join(",") || "clean";
    lines.push(`  ${wt.themeLabel}: ${wt.workspaceKey} [${flags}] ${wt.path}`);
    if (wt.recommendedAction) lines.push(`      action: ${wt.recommendedAction}`);
  }

  lines.push("");
  lines.push(hr("ACTIVITY"));
  if (model.panels.events.length === 0) lines.push("  (no events)");
  for (const event of model.panels.events.slice(0, 10)) {
    lines.push(`  [${event.severity}] ${event.themeLabel}: ${event.message}  (${event.at})`);
  }

  return lines;
}

function renderActions(model: CockpitModel): string[] {
  const lines: string[] = [hr("ACTIONS")];
  for (const action of model.actions) {
    const state = action.enabled ? "enabled" : `disabled: ${action.disabledReason ?? "unavailable"}`;
    lines.push(`  [${action.key ?? "?"}] ${action.label} — ${state}`);
  }
  return lines;
}

function renderFooter(model: CockpitModel): string[] {
  return [
    hr("FOOTER / KEYS"),
    model.help.keys.map((entry) => `${entry.key}:${entry.description}`).join("   ")
  ];
}

function renderCommandPalette(model: CockpitModel): string[] {
  if (!model.commandPaletteOpen) return [];
  const lines: string[] = [hr("COMMAND PALETTE")];
  for (const row of model.commandPalette) {
    const state = row.enabled ? "enabled" : `disabled: ${row.disabledReason ?? "unavailable"}`;
    const mutates = row.mutates ? "mutates" : "read-only";
    const backing = row.endpoint ?? row.command ?? row.section;
    lines.push(`  [${row.key}] ${row.label} — ${state}, ${mutates}${backing ? ` (${backing})` : ""}`);
  }
  return lines;
}

function renderNextActions(model: CockpitModel): string[] {
  if (model.nextActions.length === 0) return [];
  const lines: string[] = [hr("NEXT ACTIONS")];
  for (const action of model.nextActions) {
    const state = action.enabled ? "enabled" : `disabled: ${action.disabledReason ?? "n/a"}`;
    lines.push(
      `  ${action.label}: ${action.command} (${state}, ${action.mutates ? "mutates" : "read-only"})`
    );
  }
  return lines;
}

export function renderCockpitText(model: CockpitModel): string {
  const lines: string[] = [];
  const header = model.header;

  lines.push(hr("FIZZY-SYMPHONY COCKPIT (v2 spike)"));
  lines.push(`Mode: ${model.app.mode}`);
  lines.push(`Source: ${model.app.source}`);
  lines.push(`Endpoint: ${model.app.endpoint ?? "—"}`);
  lines.push(`Config: ${model.app.configPath}`);
  lines.push(
    `instance: ${header.instanceId}${header.instanceLabel ? ` (${header.instanceLabel})` : ""}` +
      ``
  );
  lines.push(
    `readiness=${header.readiness} factory=${FACTORY_STATE_LABELS[model.factoryState]}` +
      ` runner=${header.runnerStatus ?? "unknown"}`
  );
  lines.push(`updated: ${header.lastUpdatedAt}`);
  lines.push(fmtCounts(header.counts));

  lines.push("");
  lines.push(...renderSectionTabs(model));
  lines.push("");
  lines.push(...renderNextActions(model));
  lines.push("");
  lines.push(...renderSelectedSection(model));
  lines.push("");
  lines.push(...renderLegacySummary(model));
  lines.push("");
  lines.push(...renderActions(model));
  lines.push("");
  lines.push(...renderFooter(model));
  lines.push("");
  lines.push(...renderCommandPalette(model));

  return lines.join("\n");
}

export function renderCapabilitiesText(model: CockpitModel): string {
  const lines: string[] = [];
  lines.push(hr(model.help.manualTitle));
  for (const capability of model.help.capabilities) {
    const state = capability.enabled ? "enabled" : `disabled: ${capability.disabledReason ?? "n/a"}`;
    lines.push(`  [${capability.category}] ${capability.id} — ${capability.title} (${state})`);
  }
  return lines.join("\n");
}
