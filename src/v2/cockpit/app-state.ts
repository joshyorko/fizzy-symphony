import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { createRuntime } from "../daemon/runtime.ts";
import { discoverStatusEndpoints } from "../../status-discovery.js";
import { loadConfig } from "../../config.js";
import type { FixtureBundle, SymphonyRuntime, SymphonyStatus } from "../core/types.ts";
import {
  fetchV2Status,
  hasFlag,
  optionValue,
  trimEndpoint
} from "../cli/status-source.ts";

export type CockpitMode = "SETUP" | "OFFLINE" | "LIVE" | "DEMO";

export interface CockpitAppState {
  mode: CockpitMode;
  source: string;
  runtime: SymphonyRuntime;
  configPath: string;
  endpoint?: string | null;
}

export interface CockpitAppStateIo {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

const DEFAULT_CONFIG_PATH = ".fizzy-symphony/config.yml";
const DISCOVERY_PLACEHOLDER_ENV = new Set([
  "FIZZY_API_TOKEN",
  "FIZZY_WEBHOOK_SECRET"
]);

function asFixtureBundle(raw: unknown): FixtureBundle {
  if (raw && typeof raw === "object" && "status" in (raw as Record<string, unknown>)) {
    return raw as FixtureBundle;
  }
  return { status: raw as Partial<SymphonyStatus> as SymphonyStatus };
}

async function loadFixtureBundle(path: string): Promise<FixtureBundle> {
  const resolvedPath = isAbsolute(path) ? path : resolvePath(process.cwd(), path);
  const text = await readFile(resolvedPath, "utf8");
  return asFixtureBundle(JSON.parse(text));
}

async function loadEndpointBundle(endpoint: string, io: CockpitAppStateIo): Promise<{ status: SymphonyStatus; events?: FixtureBundle["events"] }> {
  const base = trimEndpoint(endpoint);
  const status = await fetchV2Status(base, io);
  let events;
  const doFetch = io.fetch ?? fetch;
  if (!doFetch) {
    return { status };
  }

  try {
    const eventsRes = await doFetch(`${base}/v2/events`);
    if (eventsRes.ok) events = ((await eventsRes.json()) as { events?: unknown }).events as FixtureBundle["events"];
  } catch {
    // Events are optional for cockpit runtime.
  }

  return { status, events };
}

function resolveConfigPath(pathOverride?: string) {
  const raw = pathOverride ?? DEFAULT_CONFIG_PATH;
  return isAbsolute(raw) ? raw : resolvePath(process.cwd(), raw);
}

function emptyStatusForMode(mode: CockpitMode): Partial<SymphonyStatus> {
  return {
    instance: { id: `cockpit-${mode.toLowerCase()}`, label: `${mode.toLowerCase()} mode` },
    readiness: { state: "unknown", ready: false, blockers: [] },
    doctor: { goalClosable: true, blockers: [] }
  };
}

async function configEndpoints(configPath: string, args: string[], io: CockpitAppStateIo) {
  const config = await loadConfig(configPath, { env: lenientDiscoveryEnv(io.env ?? process.env) });
  const registryDir = optionValue(args, "--registry-dir");
  const discoveryConfig = registryDir
    ? { ...config, server: { ...(config.server ?? {}), registry_dir: registryDir } }
    : config;
  const discovery = await discoverStatusEndpoints(discoveryConfig, {
    instanceId: optionValue(args, "--instance"),
    now: new Date()
  });
  const instances = hasFlag(args, "--no-default-endpoint")
    ? discovery.instances.filter((entry) => entry.source !== "fallback")
    : discovery.instances;

  return instances.map((entry) => entry.base_url);
}

function lenientDiscoveryEnv(env: Record<string, string | undefined>) {
  return new Proxy(env, {
    get(target, property) {
      if (typeof property !== "string") return Reflect.get(target, property);
      const value = Reflect.get(target, property);
      if (value !== undefined) return value;
      return DISCOVERY_PLACEHOLDER_ENV.has(property) ? "" : undefined;
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property !== "string") return Reflect.getOwnPropertyDescriptor(target, property);
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (descriptor || !DISCOVERY_PLACEHOLDER_ENV.has(property)) return descriptor;
      return {
        configurable: true,
        enumerable: false,
        value: "",
        writable: false
      };
    },
    has(target, property) {
      if (typeof property !== "string") return Reflect.has(target, property);
      return Reflect.has(target, property) || DISCOVERY_PLACEHOLDER_ENV.has(property);
    }
  });
}

export async function resolveCockpitApp(args: string[], io: CockpitAppStateIo = {}): Promise<CockpitAppState> {
  const endpoint = optionValue(args, "--endpoint");
  if (endpoint) {
    const normalizedEndpoint = trimEndpoint(endpoint);
    const bundle = await loadEndpointBundle(endpoint, io);
    return {
      mode: "LIVE",
      source: `endpoint ${normalizedEndpoint}`,
      endpoint: normalizedEndpoint,
      runtime: createRuntime({
        status: bundle.status,
        events: bundle.events,
        applyCommands: hasFlag(args, "--apply")
      }),
      configPath: resolveConfigPath(optionValue(args, "--config"))
    };
  }

  const fixture = optionValue(args, "--fixture");
  if (fixture) {
    const bundle = await loadFixtureBundle(fixture);
    return {
      mode: "DEMO",
      source: `fixture ${isAbsolute(fixture) ? fixture : resolvePath(process.cwd(), fixture)}`,
      runtime: createRuntime({
        status: bundle.status,
        events: bundle.events,
        capabilities: bundle.capabilities,
        applyCommands: hasFlag(args, "--apply")
      }),
      configPath: resolveConfigPath(optionValue(args, "--config"))
    };
  }

  const configPath = resolveConfigPath(optionValue(args, "--config"));
  if (!existsSync(configPath)) {
    return {
      mode: "SETUP",
      source: `config missing ${configPath}`,
      runtime: createRuntime({
        status: emptyStatusForMode("SETUP"),
        applyCommands: hasFlag(args, "--apply")
      }),
      configPath
    };
  }

  const discoveredEndpoints = await configEndpoints(configPath, args, io);
  for (const discovered of discoveredEndpoints) {
    try {
      const bundle = await loadEndpointBundle(discovered, io);
      return {
        mode: "LIVE",
        source: `endpoint ${discovered}`,
        endpoint: discovered,
        runtime: createRuntime({
          status: bundle.status,
          events: bundle.events,
          applyCommands: hasFlag(args, "--apply")
        }),
        configPath
      };
    } catch {
      // Continue to the next candidate endpoint.
    }
  }

  return {
    mode: "OFFLINE",
    source: `config ${configPath}`,
    runtime: createRuntime({
      status: emptyStatusForMode("OFFLINE"),
      applyCommands: hasFlag(args, "--apply")
    }),
    configPath
  };
}
