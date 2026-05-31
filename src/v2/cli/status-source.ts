import { discoverRegistryEndpoints } from "../../status-cli.js";
import type { SymphonyStatus } from "../core/types.ts";

const DEFAULT_REGISTRY_DIR = ".fizzy-symphony/run/instances";
const DEFAULT_ENDPOINT = "http://127.0.0.1:4567";

export interface V2StatusSourceIo {
  fetch?: typeof fetch;
}

export interface V2StatusSource {
  endpoint: string;
  status: SymphonyStatus;
}

export function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export async function fetchV2Status(endpoint: string, io: V2StatusSourceIo): Promise<SymphonyStatus> {
  const doFetch = io.fetch ?? fetch;
  if (!doFetch) throw new Error("No fetch implementation is available for v2 status discovery.");
  const res = await doFetch(`${trimEndpoint(endpoint)}/v2/status`);
  if (!res.ok) throw new Error(`GET /v2/status failed: ${res.status}`);
  return (await res.json()) as SymphonyStatus;
}

export async function discoverV2StatusSource(args: string[], io: V2StatusSourceIo): Promise<V2StatusSource | undefined> {
  const endpoints = unique([
    ...(await discoverRegistryEndpoints(optionValue(args, "--registry-dir") ?? DEFAULT_REGISTRY_DIR)),
    ...(hasFlag(args, "--no-default-endpoint") ? [] : [defaultEndpoint(args)])
  ]);

  for (const endpoint of endpoints) {
    try {
      return {
        endpoint,
        status: await fetchV2Status(endpoint, io)
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function trimEndpoint(endpoint: string): string {
  return String(endpoint).replace(/\/+$/u, "");
}

function defaultEndpoint(args: string[]) {
  const host = optionValue(args, "--host") ?? "127.0.0.1";
  const port = optionValue(args, "--port") ?? "4567";
  if (host === "127.0.0.1" && port === "4567") return DEFAULT_ENDPOINT;
  return `http://${host}:${port}`;
}

function unique(values: Array<string | undefined>) {
  return [...new Set(values.filter(Boolean) as string[])];
}
