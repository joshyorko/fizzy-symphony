import { verifyWebhookRequest } from "./fizzy-client.js";

import { normalizeTag } from "./domain.js";
import { cardBoardId, commentBody } from "./fizzy-normalize.js";

const DEFAULT_WEBHOOK_PATH = "/webhook";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_WEBHOOK_EVENT_CACHE_SIZE = 1000;
const DEFAULT_WEBHOOK_EVENT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WEBHOOK_MAX_EVENT_AGE_SECONDS = 300;
const SPAWN_EVENTS = new Set([
  "card_assigned",
  "card_board_changed",
  "card_published",
  "card_reopened",
  "card_triaged",
  "card_updated"
]);
const CANCEL_TICK_EVENTS = new Map([
  ["card_closed", "card_closed"],
  ["card_postponed", "card_postponed"],
  ["card_auto_postponed", "card_auto_postponed"],
  ["card_sent_back_to_triage", "card_left_routed_column"],
  ["card_unassigned", "card_unassigned"]
]);

export function createLocalHttpHandler(deps = {}) {
  const {
    config = {},
    status,
    enqueueWebhookHint = () => null,
    now = () => new Date(),
    logger,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    seenWebhookEventIds = createRecentWebhookEventCache({ now })
  } = deps;
  const webhookPath = normalizePath(config.webhook?.path ?? DEFAULT_WEBHOOK_PATH);

  return async function localHttpHandler(request, response) {
    try {
      const pathname = requestPathname(request);

      if (pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return writeJson(response, 200, callStatus(status, "health", { live: true, status: "live" }));
      }

      if (pathname === "/ready") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const readiness = callStatus(status, "ready", { ready: false, status: "not_ready", blockers: [] });
        return writeJson(response, readiness.ready ? 200 : 503, readiness);
      }

      if (pathname === "/status") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return writeJson(response, 200, callStatus(status, "status", {}));
      }

      const cardStatusMatch = pathname.match(/^\/status\/cards\/([^/]+)$/u);
      if (cardStatusMatch) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const cardStatus = selectCardStatus(callStatus(status, "status", {}), decodeURIComponent(cardStatusMatch[1]));
        return writeJson(response, cardStatus.found ? 200 : 404, cardStatus);
      }

      if (pathname === webhookPath) {
        if (config.webhook?.enabled === false) {
          return writeError(response, 404, "WEBHOOK_DISABLED", "Webhook intake is disabled.");
        }
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        return await handleWebhook(request, response, {
          config,
          enqueueWebhookHint,
          now,
          maxBodyBytes,
          seenWebhookEventIds
        });
      }

      return writeError(response, 404, "NOT_FOUND", "Route not found.");
    } catch (error) {
      logger?.error?.({ error }, "local HTTP handler failed");
      return writeError(response, 500, "HTTP_HANDLER_ERROR", "Local HTTP handler failed.");
    }
  };
}

export function createWebhookHintQueue(options = {}) {
  const limit = options.limit ?? 1000;
  const queue = [];

  return {
    enqueue(hint = {}) {
      const normalized = clone(hint);
      queue.push(normalized);
      while (queue.length > limit) queue.shift();
      return clone(normalized);
    },
    drain() {
      return queue.splice(0).map(clone);
    },
    snapshot() {
      return queue.map(clone);
    },
    get size() {
      return queue.length;
    }
  };
}

export function createRecentWebhookEventCache(options = {}) {
  const configuredMaxSize = Number(options.maxSize ?? DEFAULT_WEBHOOK_EVENT_CACHE_SIZE);
  const configuredTtlMs = Number(options.ttlMs ?? DEFAULT_WEBHOOK_EVENT_CACHE_TTL_MS);
  const maxSize = Number.isFinite(configuredMaxSize) ? Math.max(1, configuredMaxSize) : DEFAULT_WEBHOOK_EVENT_CACHE_SIZE;
  const ttlMs = Number.isFinite(configuredTtlMs) ? Math.max(0, configuredTtlMs) : DEFAULT_WEBHOOK_EVENT_CACHE_TTL_MS;
  const now = options.now ?? (() => new Date());
  const entries = new Map();

  function prune() {
    const current = nowMs(now);
    if (ttlMs > 0) {
      const cutoff = current - ttlMs;
      for (const [eventId, seenAt] of entries.entries()) {
        if (seenAt < cutoff) entries.delete(eventId);
      }
    }
    while (entries.size > maxSize) {
      entries.delete(entries.keys().next().value);
    }
  }

  return {
    has(eventId) {
      if (!eventId) return false;
      prune();
      return entries.has(String(eventId));
    },
    add(eventId) {
      if (!eventId) return;
      prune();
      const key = String(eventId);
      entries.delete(key);
      entries.set(key, nowMs(now));
      prune();
    },
    snapshot() {
      prune();
      return [...entries.keys()];
    },
    get size() {
      prune();
      return entries.size;
    }
  };
}

async function handleWebhook(request, response, options = {}) {
  const {
    config = {},
    enqueueWebhookHint,
    now,
    maxBodyBytes,
    seenWebhookEventIds
  } = options;

  let rawBody;
  try {
    rawBody = await readRawBody(request, { maxBodyBytes });
  } catch (error) {
    if (error.code === "WEBHOOK_BODY_TOO_LARGE") {
      return writeError(response, 413, error.code, "Webhook request body is too large.");
    }
    throw error;
  }

  const secret = config.webhook?.secret ? String(config.webhook.secret) : "";
  if (secret) {
    const supplied = request.headers["x-webhook-signature"];
    if (!supplied) {
      return writeError(response, 401, "WEBHOOK_SIGNATURE_REQUIRED", "Webhook signature is required.");
    }
    const verification = verifyWebhookRequest({
      rawBody,
      headers: request.headers,
      secret,
      now: currentDate(now)
    });
    if (!verification.ok && verification.code === "INVALID_WEBHOOK_SIGNATURE") {
      return writeError(response, 401, "WEBHOOK_SIGNATURE_INVALID", "Webhook signature is invalid.");
    }
    if (!verification.ok) {
      return writeError(response, verification.status ?? 400, verification.code, webhookVerificationMessage(verification.code));
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return writeError(response, 400, "INVALID_WEBHOOK_PAYLOAD", "Webhook payload must be valid JSON.");
  }

  const freshness = eventFreshness(event, request.headers, config, now);
  if (!freshness.ok) {
    return writeError(response, 400, freshness.code, freshness.message, freshness.details);
  }

  const classification = classifyWebhookEvent(event, { config });
  const hint = candidateHintFromWebhookEvent(event, { config, now, classification });

  if (hint.event_id && seenWebhookEventIds.has(hint.event_id)) {
    return writeJson(response, 200, {
      ok: true,
      status: "duplicate",
      hint: publicHint(hint),
      signature_verification: secret ? "enabled" : "disabled",
      webhook_management: config.webhook?.manage ? "managed" : "unmanaged"
    });
  }

  if (classification.status === "ignored") {
    if (hint.event_id) seenWebhookEventIds.add(hint.event_id);
    return writeJson(response, 200, {
      ok: true,
      status: "ignored",
      reason: classification.reason,
      hint: publicHint(hint),
      signature_verification: secret ? "enabled" : "disabled",
      webhook_management: config.webhook?.manage ? "managed" : "unmanaged"
    });
  }

  if (!hint.card_id) {
    return writeError(response, 400, "INVALID_WEBHOOK_PAYLOAD", "Webhook payload must identify a candidate card.");
  }

  if (hint.event_id) seenWebhookEventIds.add(hint.event_id);
  await enqueueWebhookHint(hint);

  return writeJson(response, 202, {
    ok: true,
    status: "accepted",
    hint: publicHint(hint),
    signature_verification: secret ? "enabled" : "disabled",
    webhook_management: config.webhook?.manage ? "managed" : "unmanaged"
  });
}

function selectCardStatus(snapshot = {}, cardId) {
  const runs = snapshot.runs ?? {};
  const selectedRuns = {};
  for (const bucket of ["queued", "running", "completed", "failed", "cancelled", "preempted"]) {
    selectedRuns[bucket] = (runs[bucket] ?? []).filter((run) => run.card_id === cardId || run.card?.id === cardId);
  }
  const found = Object.values(selectedRuns).some((entries) => entries.length > 0);
  return {
    found,
    card_id: cardId,
    runs: selectedRuns,
    claims: (snapshot.claims ?? []).filter((claim) => claim.card_id === cardId),
    workpads: (snapshot.workpads ?? []).filter((workpad) => workpad.card_id === cardId || workpad.id === cardId)
  };
}

function readRawBody(request, { maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        const error = new Error("Webhook request body is too large.");
        error.code = "WEBHOOK_BODY_TOO_LARGE";
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function classifyWebhookEvent(event, { config = {} } = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return { status: "ignored", reason: "unsupported_event" };
  }

  const action = eventAction(event);
  const card = eventCard(event);

  if (isAgentInstructionsCard(card)) {
    return { status: "accepted", intent: "refresh_routes", reason: "golden_ticket_changed" };
  }

  if (action === "comment_created") {
    if (hasRerunSignal(event, card)) {
      return { status: "accepted", intent: "spawn", reason: "comment_created:rerun" };
    }
    if (isSelfAuthoredEvent(event, config)) {
      return { status: "ignored", reason: "self_authored_comment" };
    }
    return { status: "ignored", reason: "comment_without_rerun_signal" };
  }

  if (SPAWN_EVENTS.has(action)) {
    return { status: "accepted", intent: "spawn", reason: action };
  }

  if (CANCEL_TICK_EVENTS.has(action)) {
    return { status: "accepted", intent: "cancel_tick", reason: action, cancel_reason: CANCEL_TICK_EVENTS.get(action) };
  }

  return { status: "ignored", reason: "unsupported_event" };
}

function candidateHintFromWebhookEvent(event, { config = {}, now = () => new Date(), classification = {} } = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return {};

  const card = eventCard(event);
  const board = event.board ?? event.data?.board ?? event.payload?.board ?? {};
  const cardId = event.card_id ?? event.cardId ?? card.id ?? card.card_id;
  const boardId = event.board_id ?? event.boardId ?? board.id ?? board.board_id ?? board.boardId ?? cardBoardId(card);
  const action = normalizeAction(event.action ?? event.type ?? event.event_type ?? event.eventType);
  const rerunRequested = hasExplicitRerunSignal(event, card);

  return omitUndefined({
    source: "webhook",
    intent: classification.intent,
    reason: classification.reason,
    event_id: event.event_id ?? event.eventId ?? event.id,
    action,
    cancel_reason: classification.cancel_reason,
    card_id: cardId,
    board_id: boardId,
    rerun_requested: rerunRequested || undefined,
    received_at: toIso(typeof now === "function" ? now() : now)
  });
}

function publicHint(hint = {}) {
  return omitUndefined({
    intent: hint.intent,
    reason: hint.reason,
    event_id: hint.event_id,
    action: hint.action,
    cancel_reason: hint.cancel_reason,
    card_id: hint.card_id,
    board_id: hint.board_id,
    rerun_requested: hint.rerun_requested
  });
}

function eventAction(event = {}) {
  const action = event.action ?? event.event ?? event.type ?? event.data?.action ?? event.payload?.action;
  return normalizeAction(action);
}

function eventCard(event = {}) {
  return event.card ?? event.data?.card ?? event.payload?.card ?? {};
}

function isAgentInstructionsCard(card = {}) {
  return normalizedTags(card).includes("agent-instructions");
}

function hasRerunSignal(event = {}, card = eventCard(event)) {
  if (event.rerun_requested === true || event.rerunRequested === true) return true;
  if (normalizedTags(card).includes("agent-rerun")) return true;
  if (normalizedTags(event).includes("agent-rerun")) return true;
  const comment = event.comment ?? event.data?.comment ?? event.payload?.comment ?? {};
  return /\bagent-rerun\b/iu.test(String(commentBody(comment) ?? comment.body ?? comment.text ?? ""));
}

function normalizedTags(source = {}) {
  const tags = source.tags ?? source.tag_names ?? source.tagNames ?? [];
  if (!Array.isArray(tags)) return [];
  return tags.map(normalizeTag).filter(Boolean);
}

function isSelfAuthoredEvent(event = {}, config = {}) {
  const actorIds = eventActors(event);
  const daemonIds = [
    config.fizzy?.bot_user_id,
    config.fizzy?.botUserId,
    config.instance?.id
  ].filter(Boolean).map(String);
  if (daemonIds.length === 0) return false;
  return actorIds.some((actorId) => daemonIds.includes(actorId));
}

function eventActors(event = {}) {
  const comment = event.comment ?? event.data?.comment ?? event.payload?.comment ?? {};
  return [
    event.actor?.id,
    event.user?.id,
    event.author?.id,
    event.created_by?.id,
    event.data?.actor?.id,
    event.payload?.actor?.id,
    comment.author_id,
    comment.authorId,
    comment.user_id,
    comment.author?.id,
    comment.user?.id
  ].filter((value) => value !== undefined && value !== null).map(String);
}

function webhookVerificationMessage(code) {
  if (code === "STALE_WEBHOOK_EVENT") {
    return "Webhook timestamp is missing, invalid, or outside the freshness tolerance.";
  }
  return "Webhook request verification failed.";
}

function eventFreshness(event, headers = {}, config = {}, now = () => new Date()) {
  const timestamp = eventTimestamp(event) ?? headerValue(headers, "x-webhook-timestamp");
  if (!timestamp) return { ok: true };

  const eventTime = Date.parse(timestamp);
  const nowValue = typeof now === "function" ? now() : now;
  const nowTime = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
  const maxAgeSeconds = Number(config.webhook?.max_event_age_seconds ?? DEFAULT_WEBHOOK_MAX_EVENT_AGE_SECONDS);
  if (!Number.isFinite(eventTime) || !Number.isFinite(nowTime)) {
    return {
      ok: false,
      code: "STALE_WEBHOOK_EVENT",
      message: "Webhook event timestamp is invalid or stale.",
      details: { timestamp }
    };
  }

  const ageMs = Math.abs(nowTime - eventTime);
  if (ageMs <= maxAgeSeconds * 1000) return { ok: true };
  return {
    ok: false,
    code: "STALE_WEBHOOK_EVENT",
    message: "Webhook event timestamp is outside the allowed freshness window.",
    details: {
      timestamp,
      max_event_age_seconds: maxAgeSeconds,
      age_ms: ageMs
    }
  };
}

function eventTimestamp(event = {}) {
  return event.created_at ??
    event.createdAt ??
    event.timestamp ??
    event.event_timestamp ??
    event.eventTimestamp ??
    event.delivered_at ??
    event.deliveredAt ??
    event.data?.created_at ??
    event.payload?.created_at;
}

function hasExplicitRerunSignal(event = {}, card = {}) {
  return hasRerunSignal(event, card);
}

function normalizeAction(action) {
  const value = String(action ?? "").trim();
  if (!value) return undefined;
  return value.replace(/[.\s-]+/gu, "_").toLowerCase();
}

function callStatus(status, method, fallback) {
  return typeof status?.[method] === "function" ? status[method]() : fallback;
}

function headerValue(headers = {}, name) {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lowerName) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function requestPathname(request) {
  return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
}

function normalizePath(path) {
  const value = String(path || DEFAULT_WEBHOOK_PATH);
  return value.startsWith("/") ? value : `/${value}`;
}

function methodNotAllowed(response, allowed) {
  return writeError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed.", {}, {
    allow: allowed.join(", ")
  });
}

function writeError(response, statusCode, code, message, details = {}, headers = {}) {
  return writeJson(response, statusCode, { ok: false, error: { code, message, details } }, headers);
}

function writeJson(response, statusCode, body, headers = {}) {
  if (response.headersSent) return;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function currentDate(now) {
  return typeof now === "function" ? now() : now;
}

function nowMs(now) {
  const value = currentDate(now);
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function omitUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}
