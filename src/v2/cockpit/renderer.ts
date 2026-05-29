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

export function renderCockpitText(model: CockpitModel): string {
  const lines: string[] = [];
  const header = model.header;

  lines.push(hr("FIZZY-SYMPHONY COCKPIT (v2 spike)"));
  lines.push(
    `instance: ${header.instanceId}${header.instanceLabel ? ` (${header.instanceLabel})` : ""}` +
      `   endpoint: ${header.endpoint ?? "—"}`
  );
  lines.push(
    `readiness: ${header.readiness}   factory: ${FACTORY_STATE_LABELS[model.factoryState]}` +
      `   runner: ${header.runnerStatus ?? "unknown"}`
  );
  lines.push(`updated: ${header.lastUpdatedAt}`);
  lines.push(fmtCounts(header.counts));

  lines.push("");
  lines.push(hr("BOARD / FACTORY LANES"));
  if (model.lanes.length === 0) {
    lines.push("  (no routes)");
  }
  for (const lane of model.lanes) {
    const laneState = lane.enabled ? "" : `  [disabled: ${lane.disabledReason ?? "unknown"}]`;
    lines.push(`▣ ${lane.title}  «${lane.factoryLine}»  [route ${lane.routeId}]${laneState}`);
    if (lane.cards.length === 0) {
      lines.push("    (no cards)");
    }
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

  if (model.selected) {
    lines.push("");
    lines.push(hr("SELECTED DETAIL (raw truth)"));
    lines.push(`kind: ${model.selected.kind}   theme: ${model.selected.themeLabel ?? "—"}`);
    for (const [key, value] of Object.entries(model.selected.raw)) {
      if (value === undefined || value === null) continue;
      lines.push(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
    if (model.selected.recommendedAction) {
      lines.push(`  recommendedAction: ${model.selected.recommendedAction}`);
    }
  }

  lines.push("");
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

  lines.push("");
  lines.push(hr("ACTIONS"));
  for (const action of model.actions) {
    const state = action.enabled
      ? "enabled"
      : `disabled: ${action.disabledReason ?? "unavailable"}`;
    lines.push(`  [${action.key ?? "?"}] ${action.label} — ${state}`);
  }

  lines.push("");
  lines.push(hr("FOOTER / KEYS"));
  lines.push(model.help.keys.map((entry) => `${entry.key}:${entry.description}`).join("   "));

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
