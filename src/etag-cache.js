import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const SCHEMA_VERSION = "fizzy-symphony-etag-cache-v1";
const CACHE_FILE = "etag-cache.json";

export function createEtagCache(options = {}) {
  const { config = {}, now = () => new Date() } = options;
  const stateDir = config.observability?.state_dir ?? join(process.cwd(), ".fizzy-symphony", "run");
  const path = options.path ?? join(stateDir, CACHE_FILE);
  const context = cacheContext(config);
  const contextFingerprint = digest(context);
  const counters = { hits: 0, misses: 0, invalid: 0 };
  let loaded = false;
  let entries = {};

  async function load() {
    if (loaded) return;
    loaded = true;

    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      counters.invalid += 1;
      entries = {};
      return;
    }

    if (
      parsed?.schema_version !== SCHEMA_VERSION ||
      parsed?.context_fingerprint !== contextFingerprint ||
      !isPlainObject(parsed.entries)
    ) {
      counters.invalid += 1;
      entries = {};
      return;
    }

    entries = { ...parsed.entries };
  }

  async function save() {
    await mkdir(dirname(path), { recursive: true });
    const body = `${JSON.stringify({
      schema_version: SCHEMA_VERSION,
      context,
      context_fingerprint: contextFingerprint,
      saved_at: toIso(now),
      entries
    }, null, 2)}\n`;
    const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmpPath, body, "utf8");
    await rename(tmpPath, path);
    return { path, bytes: Buffer.byteLength(body) };
  }

  function get(resource) {
    const lookupResult = lookup(resource);
    return lookupResult.entry ?? null;
  }

  function lookup(resource) {
    const key = resourceKey(resource);
    const entry = entries[key];
    if (entry === undefined) {
      counters.misses += 1;
      return { status: "missing", key };
    }
    if (!isValidEntry(entry)) {
      counters.invalid += 1;
      delete entries[key];
      return { status: "invalid", key };
    }
    return { status: "valid", key, entry: clone(entry) };
  }

  function set(resource, entry = {}) {
    entries[resourceKey(resource)] = {
      etag: entry.etag,
      snapshot: clone(entry.snapshot),
      stored_at: toIso(now)
    };
  }

  function recordHit() {
    counters.hits += 1;
  }

  function recordMiss() {
    counters.misses += 1;
  }

  function recordInvalid() {
    counters.invalid += 1;
  }

  return {
    path,
    context,
    context_fingerprint: contextFingerprint,
    load,
    save,
    get,
    lookup,
    set,
    recordHit,
    recordMiss,
    recordInvalid,
    stats: () => ({ ...counters })
  };
}

export function resourceKey(resource = {}) {
  return digest({
    type: resource.type ?? "unknown",
    id: resource.id ?? null,
    query: resource.query ?? null
  });
}

export function cacheContext(config = {}) {
  return {
    account: config.fizzy?.account ?? "",
    api_url: config.fizzy?.api_url ?? "",
    auth_fingerprint: authFingerprint(config.fizzy ?? {}),
    board_ids: enabledBoardIds(config),
    polling: {
      use_etags: config.polling?.use_etags !== false,
      use_api_filters: config.polling?.use_api_filters !== false,
      api_filters: normalizeForContext(config.polling?.api_filters ?? {})
    }
  };
}

function enabledBoardIds(config) {
  return [...new Set((config.boards?.entries ?? [])
    .filter((entry) => entry.enabled !== false)
    .map((entry) => String(entry.id))
    .filter(Boolean))]
    .sort();
}

function authFingerprint(fizzy) {
  const token = fizzy.token ?? fizzy.auth_token ?? fizzy.api_token ?? "";
  return `sha256:${createHash("sha256").update(String(token)).digest("hex")}`;
}

function isValidEntry(entry) {
  return isPlainObject(entry) && typeof entry.etag === "string" && entry.etag.length > 0 && Object.hasOwn(entry, "snapshot");
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeForContext(value) {
  if (Array.isArray(value)) return value.map(normalizeForContext);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeForContext(value[key])]));
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toIso(now) {
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
