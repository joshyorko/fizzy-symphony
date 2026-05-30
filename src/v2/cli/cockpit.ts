// `fizzy-symphony cockpit` command.
//
// Modes:
//   cockpit                         interactive (TTY) or static (non-TTY)
//   cockpit --endpoint URL          read snapshot from a running v2 daemon
//   cockpit --fixture PATH          read a fixture bundle
//   cockpit --once                  print one static frame and exit
//   cockpit --json                  print the cockpit model as JSON and exit
//
// Layering rule: this command builds a runtime (fixture or snapshot), derives
// the pure cockpit model, then renders. It never reaches into Fizzy/Codex.

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCockpitModel } from "../cockpit/model.ts";
import { renderCockpitText } from "../cockpit/renderer.ts";
import { startInteractiveCockpit } from "../cockpit/interactive.ts";
import { createRuntime } from "../daemon/runtime.ts";
import type { SymphonyRuntime } from "../daemon/runtime.ts";
import type { FixtureBundle, SymphonyStatus } from "../core/types.ts";

export interface CockpitIo {
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  stdoutIsTTY?: boolean;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_FIXTURE = join(PACKAGE_ROOT, "test", "fixtures", "v2", "ready.json");

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function asBundle(raw: unknown): FixtureBundle {
  if (raw && typeof raw === "object" && "status" in (raw as Record<string, unknown>)) {
    return raw as FixtureBundle;
  }
  return { status: raw as Partial<SymphonyStatus> as SymphonyStatus };
}

async function loadFixtureBundle(path: string): Promise<FixtureBundle> {
  const resolved = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const text = await readFile(resolved, "utf8");
  return asBundle(JSON.parse(text));
}

async function loadEndpointBundle(endpoint: string, io: CockpitIo): Promise<FixtureBundle> {
  const doFetch = io.fetch ?? fetch;
  const base = endpoint.replace(/\/$/, "");
  const statusRes = await doFetch(`${base}/v2/status`);
  if (!statusRes.ok) throw new Error(`GET /v2/status failed: ${statusRes.status}`);
  const status = (await statusRes.json()) as SymphonyStatus;
  let events;
  try {
    const eventsRes = await doFetch(`${base}/v2/events`);
    if (eventsRes.ok) events = ((await eventsRes.json()) as { events?: unknown }).events as FixtureBundle["events"];
  } catch {
    // events are optional
  }
  return { status, events };
}

async function buildRuntime(args: string[], io: CockpitIo): Promise<{ runtime: SymphonyRuntime; source: string }> {
  const endpoint = optionValue(args, "--endpoint");
  const fixture = optionValue(args, "--fixture");
  // --apply makes operator commands mutate the in-memory status model instead
  // of being recorded as dry-runs. Off by default to keep the cockpit read-only.
  const applyCommands = hasFlag(args, "--apply");
  if (endpoint) {
    const bundle = await loadEndpointBundle(endpoint, io);
    return {
      runtime: createRuntime({ status: bundle.status, events: bundle.events, applyCommands }),
      source: `endpoint ${endpoint}`
    };
  }
  const fixturePath = fixture ?? DEFAULT_FIXTURE;
  const bundle = await loadFixtureBundle(fixturePath);
  return {
    runtime: createRuntime({
      status: bundle.status,
      events: bundle.events,
      capabilities: bundle.capabilities,
      applyCommands
    }),
    source: `fixture ${fixturePath}${applyCommands ? " [apply]" : ""}`
  };
}

export async function runCockpitCommand(args: string[], io: CockpitIo): Promise<number> {
  let runtime: SymphonyRuntime;
  let source: string;
  try {
    ({ runtime, source } = await buildRuntime(args, io));
  } catch (error) {
    io.stderr.write(`cockpit: failed to load source: ${(error as Error).message}\n`);
    return 1;
  }

  const wantJson = hasFlag(args, "--json");
  const wantOnce = hasFlag(args, "--once");
  const isTty = io.stdoutIsTTY ?? Boolean((io.stdout as { isTTY?: boolean }).isTTY);

  const model = createCockpitModel({
    status: runtime.getStatus(),
    events: runtime.getEvents(20),
    capabilities: runtime.getCapabilities(),
    selectedId: optionValue(args, "--select")
  });

  if (wantJson) {
    io.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
    return 0;
  }

  if (wantOnce || !isTty) {
    if (!isTty && !wantOnce) {
      io.stderr.write(`cockpit: non-TTY detected, printing static frame (${source}).\n`);
    }
    io.stdout.write(`${renderCockpitText(model)}\n`);
    return 0;
  }

  // Interactive TTY mode.
  try {
    const session = await startInteractiveCockpit({ runtime });
    await session.done;
    return 0;
  } catch (error) {
    io.stderr.write(`cockpit: interactive renderer unavailable (${(error as Error).message}); static frame:\n`);
    io.stdout.write(`${renderCockpitText(model)}\n`);
    return 0;
  }
}
