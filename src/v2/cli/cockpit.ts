// `fizzy-symphony cockpit` command.
//
// Modes:
//   cockpit --endpoint URL          read a snapshot from a running v2 daemon (strict)
//   cockpit --fixture PATH          read a fixture bundle (demo mode)
//   cockpit --once                  print one static frame and exit
//   cockpit                        auto-resolve mode from config/daemon/fixtures
//
// Layering rule: resolve source/mode in app-state, then derive runtime and render.

import { createCockpitModel } from "../cockpit/model.ts";
import { renderCockpitText } from "../cockpit/renderer.ts";
import { startInteractiveCockpit } from "../cockpit/interactive.ts";
import { optionValue } from "./status-source.ts";
import { resolveCockpitApp } from "../cockpit/app-state.ts";
import type { CockpitAppState } from "../cockpit/app-state.ts";

export interface CockpitIo {
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  stdoutIsTTY?: boolean;
}

export async function runCockpitCommand(args: string[], io: CockpitIo): Promise<number> {
  let appState: CockpitAppState;
  try {
    appState = await resolveCockpitApp(args, io);
  } catch (error) {
    io.stderr.write(`cockpit: failed to load source: ${(error as Error).message}\n`);
    return 1;
  }

  const { runtime, source, mode, configPath } = appState;
  const wantJson = args.includes("--json");
  const wantOnce = args.includes("--once");
  const isTty = io.stdoutIsTTY ?? Boolean((io.stdout as { isTTY?: boolean }).isTTY);
  const env = io.env ?? process.env;
  const colorEnabled = resolveColor(args, env, isTty);
  const width = Number((io.stdout as { columns?: number }).columns) || 100;
  const renderOptions = { color: colorEnabled, width };

  const app = {
    mode,
    source,
    configPath,
    endpoint: appState.endpoint
  };

  const model = createCockpitModel({
    status: runtime.getStatus(),
    events: runtime.getEvents(20),
    capabilities: runtime.getCapabilities(),
    selectedId: optionValue(args, "--select"),
    app
  });

  if (wantJson) {
    io.stdout.write(`${JSON.stringify({ app: "cockpit", mode, source, model }, null, 2)}\n`);
    return 0;
  }

  if (wantOnce || !isTty) {
    if (!isTty && !wantOnce) {
      io.stderr.write(`cockpit: non-TTY detected, printing static frame (${source}).\n`);
    }
    io.stdout.write(`${renderCockpitText(model, renderOptions)}\n`);
    return 0;
  }

  // Interactive TTY mode.
  try {
    const session = await startInteractiveCockpit({ runtime, app, color: colorEnabled, width });
    await session.done;
    return 0;
  } catch (error) {
    io.stderr.write(`cockpit: interactive renderer unavailable (${(error as Error).message}); static frame:\n`);
    io.stdout.write(`${renderCockpitText(model, renderOptions)}\n`);
    return 0;
  }
}

// Color is opt-in and respects the usual terminal contracts: explicit
// --color/--no-color override, otherwise enabled only for a real TTY with
// NO_COLOR unset, CI unset, and TERM other than "dumb".
function resolveColor(args: string[], env: Record<string, string | undefined>, isTty: boolean): boolean {
  if (args.includes("--no-color")) return false;
  if (args.includes("--color")) return true;
  return isTty && env.NO_COLOR === undefined && env.CI === undefined && env.TERM !== "dumb";
}
