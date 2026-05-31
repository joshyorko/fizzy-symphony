// `fizzy-symphony capabilities` command.
//
// Prints the capability registry (optionally derived against a fixture/endpoint
// status snapshot so disabled reasons are live). Supports --json.

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { deriveCapabilities, listCapabilities } from "../core/capabilities.ts";
import { normalizeStatus } from "../core/status.ts";
import { discoverV2StatusSource, fetchV2Status, optionValue } from "./status-source.ts";
import type { Capability, FixtureBundle, SymphonyStatus } from "../core/types.ts";

export interface CapabilitiesIo {
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  fetch?: typeof fetch;
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
    return normalizeStatus(await fetchV2Status(endpoint, io));
  }
  const discovered = await discoverV2StatusSource(args, io);
  return discovered ? normalizeStatus(discovered.status) : undefined;
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
