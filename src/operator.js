import { loadConfig } from "./config.js";
import { scanWorkspaceMetadata } from "./workspace.js";

export async function runWorktreesCommand(args = [], io = {}) {
  const config = await loadOperatorConfig(args, io);
  const report = await scanWorkspaceMetadata({ config });
  let worktrees = report.workspaces;

  const cardNumber = optionValue(args, "--card");
  if (cardNumber) {
    worktrees = worktrees.filter((entry) => String(entry.card_number) === String(cardNumber).replace(/^#/u, ""));
  }
  if (args.includes("--dirty-only")) {
    worktrees = worktrees.filter((entry) => entry.git_status === "dirty");
  }

  const payload = { ok: true, worktrees, summary: summarizeWorktrees(report, worktrees) };
  if (args.includes("--json")) {
    io.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    io.stdout.write(formatWorktrees(payload));
  }
  return 0;
}

export async function runDoctorCommand(args = [], io = {}) {
  const config = await loadOperatorConfig(args, io);
  const report = await scanWorkspaceMetadata({ config });
  const failures = goalFailures({ report });
  const payload = {
    ok: failures.length === 0,
    mode: args.includes("--goal") ? "goal" : "default",
    failures,
    summary: summarizeWorktrees(report, report.workspaces)
  };

  if (args.includes("--json")) {
    io.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    io.stdout.write(formatDoctor(payload));
  }
  return payload.ok ? 0 : 2;
}

function goalFailures({ report }) {
  const failures = [];
  for (const workspace of report.dirty_worktrees ?? []) {
    failures.push({
      code: "DIRTY_WORKTREE",
      message: "Symphony worktree has local changes.",
      workspace_path: workspace.workspace_path,
      dirty_paths: workspace.dirty_paths ?? [],
      card_number: workspace.card_number,
      run_id: workspace.run_id,
      recommended_action: "Inspect the worktree and either finish/recover the work or create an explicit rerun/follow-up."
    });
  }
  for (const warning of report.preserved_workspaces ?? []) {
    failures.push({
      code: warning.code,
      message: warning.message,
      workspace_path: warning.workspace_path,
      workspace_key: warning.workspace_key,
      recommended_action: "Inspect preserved workspace metadata before closing the goal."
    });
  }
  for (const workspace of report.workspaces ?? []) {
    if (workspace.status === "failed" && workspace.git_status !== "dirty") {
      failures.push({
        code: "UNTRIAGED_FAILED_RUN",
        message: "A failed run artifact is still present.",
        workspace_path: workspace.workspace_path,
        card_number: workspace.card_number,
        run_id: workspace.run_id,
        last_error: workspace.last_error,
        recommended_action: "Triage the failed run and record a rerun or follow-up decision."
      });
    }
  }
  return failures;
}

function summarizeWorktrees(report, worktrees) {
  return {
    worktrees: worktrees.length,
    dirty: worktrees.filter((entry) => entry.git_status === "dirty").length,
    preserved: report.preserved_workspaces?.length ?? 0
  };
}

function formatWorktrees({ worktrees, summary }) {
  const lines = [
    `Worktrees: ${summary.worktrees} (${summary.dirty} dirty, ${summary.preserved} preserved warnings)`
  ];
  for (const entry of worktrees) {
    lines.push([
      `#${entry.card_number ?? "?"}`,
      entry.status ?? "unknown",
      entry.git_status ?? "unknown",
      entry.workspace_path ?? entry.workspace_key ?? "unknown-worktree"
    ].join(" | "));
    if (entry.dirty_paths?.length) lines.push(`  dirty: ${entry.dirty_paths.join(", ")}`);
    if (entry.last_error?.code) lines.push(`  last_error: ${entry.last_error.code}`);
    if (entry.recommended_action && entry.recommended_action !== "none") lines.push(`  recommended_action: ${entry.recommended_action}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatDoctor({ ok, failures, summary }) {
  if (ok) {
    return `Goal doctor: OK (${summary.worktrees} worktrees, ${summary.dirty} dirty)\n`;
  }
  const lines = [`Goal doctor: BLOCKED (${failures.length} issue${failures.length === 1 ? "" : "s"})`];
  for (const failure of failures) {
    lines.push(`${failure.code}: ${failure.message}`);
    if (failure.workspace_path) lines.push(`  worktree: ${failure.workspace_path}`);
    if (failure.dirty_paths?.length) lines.push(`  dirty: ${failure.dirty_paths.join(", ")}`);
    if (failure.recommended_action) lines.push(`  remediation: ${failure.recommended_action}`);
  }
  return `${lines.join("\n")}\n`;
}

async function loadOperatorConfig(args, io) {
  const configPath = optionValue(args, "--config") ?? ".fizzy-symphony/config.yml";
  return loadConfig(configPath, { env: io.env ?? process.env });
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}
