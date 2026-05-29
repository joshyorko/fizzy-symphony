// `fizzy-symphony capabilities` command.
//
// Prints the capability registry (optionally derived against a fixture/endpoint
// status snapshot so disabled reasons are live). Supports --json.

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { deriveCapabilities, listCapabilities } from "../core/capabilities.ts";
import { normalizeStatus } from "../core/status.ts";
import type { Capability, FixtureBundle, SymphonyStatus } from "../core/types.ts";

export interface CapabilitiesIo {
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  fetch?: typeof fetch;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function statusFromArgs(args: string[], io: CapabilitiesIo): Promise<SymphonyStatus | undefined> {
  const fixture = optionValue(args, "--fixture");
  const endpoint = optionValue(args, "--endpoint");
  if (fixture) {
    const path = isAbsolute(fixture) ? fixture : resolve(process.cwd(), fixture);
    const raw = JSON.parse(await readFile(path, "utf8")) as FixtureBundle | SymphonyStatus;
    const status = "status" in (raw as Record<string, unknown>) ? (raw as FixtureBundle).status : (raw as SymphonyStatus);
    return normalizeStatus(status);
  }
  if (endpoint) {
    const doFetch = io.fetch ?? fetch;
    const res = await doFetch(`${endpoint.replace(/\/$/, "")}/v2/status`);
    if (!res.ok) throw new Error(`GET /v2/status failed: ${res.status}`);
    return normalizeStatus((await res.json()) as SymphonyStatus);
  }
  return undefined;
}

export async function runCapabilitiesCommand(args: string[], io: CapabilitiesIo): Promise<number> {
  let capabilities: Capability[];
  try {
    const status = await statusFromArgs(args, io);
    capabilities = status ? deriveCapabilities(status) : listCapabilities();
  } catch (error) {
    io.stderr.write(`capabilities: ${(error as Error).message}\n`);
    return 1;
  }

  if (args.includes("--json")) {
    io.stdout.write(`${JSON.stringify({ capabilities }, null, 2)}\n`);
    return 0;
  }

  io.stdout.write("fizzy-symphony capabilities (v2)\n");
  for (const capability of capabilities) {
    const state = capability.enabled ? "enabled " : "DISABLED";
    const reason = capability.enabled ? "" : `  (${capability.disabledReason ?? "n/a"})`;
    io.stdout.write(`  [${state}] ${capability.category.padEnd(11)} ${capability.id} — ${capability.title}${reason}\n`);
  }
  return 0;
}
