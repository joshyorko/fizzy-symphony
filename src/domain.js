import { createHash } from "node:crypto";

import { asArray, cardColumnId, cardDescription, commentBody, richText } from "./fizzy-normalize.js";

const DIGEST_PREFIX = "sha256:";

export function canonicalJson(value) {
  const serialized = serializeCanonical(value);
  if (serialized === undefined) {
    throw new TypeError("Cannot canonicalize a value with no JSON representation.");
  }
  return serialized;
}

export function digest(value) {
  return `${DIGEST_PREFIX}${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function shortDigest(value, length = 12) {
  return digest(value).slice(DIGEST_PREFIX.length, DIGEST_PREFIX.length + length);
}

export function normalizeTag(tag) {
  const raw = typeof tag === "string" ? tag : tag?.name ?? tag?.title ?? tag?.slug ?? tag?.label ?? tag?.value ?? "";
  return String(raw).trim().replace(/^#+/u, "").toLowerCase();
}

export function normalizedTags(card) {
  const tags = [];
  const seen = new Set();

  for (const tag of asArray(card?.tags ?? card?.tag_names ?? card?.tagNames)) {
    const normalized = normalizeTag(tag);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }

  return tags;
}

export function completionSlug(name) {
  return String(name ?? "").trim().toLowerCase().replace(/[\s-]+/gu, "-");
}

export function sanitizeWorkspaceSegment(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]/gu, "_");
}

export function cardDigest(card = {}, route = {}) {
  const payload = {
    card_id: card.id ?? card.card_id ?? null,
    card_number: card.number ?? card.card_number ?? null,
    title: card.title ?? "",
    description: cardDescription(card),
    steps: normalizeSteps(card.steps),
    tags: normalizedNonDaemonTags(card),
    closed: Boolean(card.closed ?? card.is_closed ?? card.closed_at ?? false),
    postponed: Boolean(card.postponed ?? card.is_postponed ?? card.postponed_at ?? card.postponed_until ?? false),
    source_column_id: cardColumnId(card),
    route_id: route.id ?? route.route_id ?? null,
    route_fingerprint: route.fingerprint ?? route.route_fingerprint ?? null
  };

  const lastActiveAt = card.last_active_at ?? card.lastActiveAt;
  if (lastActiveAt !== undefined && lastActiveAt !== null && lastActiveAt !== "") {
    payload.last_active_at = normalizeTimestamp(lastActiveAt);
  }

  const comments = normalizeNonDaemonComments(card.comments);
  if (comments.length > 0) {
    payload.comments = comments;
  }

  return digest(payload);
}

function serializeCanonical(value) {
  if (value instanceof Date) {
    return serializeCanonical(normalizeTimestamp(value));
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonical(item) ?? "null").join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        const serialized = serializeCanonical(value[key]);
        return serialized === undefined ? undefined : `${JSON.stringify(key)}:${serialized}`;
      })
      .filter((entry) => entry !== undefined)
      .join(",")}}`;
  }

  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  return JSON.stringify(value);
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toISOString();
}

function normalizeSteps(steps = []) {
  return asArray(steps).map((step) => {
    if (typeof step === "string") {
      return { id: null, title: step, checked: false };
    }

    return {
      id: step?.id ?? step?.step_id ?? null,
      title: richText(step?.title ?? step?.name ?? step?.text ?? step?.description ?? step?.body ?? ""),
      checked: Boolean(step?.checked ?? step?.is_checked ?? step?.completed ?? step?.complete ?? false)
    };
  });
}

function normalizedNonDaemonTags(card) {
  const tags = [];
  const seen = new Set();

  for (const tag of asArray(card?.tags ?? card?.tag_names ?? card?.tagNames)) {
    const normalized = normalizeTag(tag);
    if (!normalized || isDaemonTag(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }

  return tags;
}

function normalizeNonDaemonComments(comments = []) {
  return asArray(comments)
    .filter((comment) => !isDaemonMarkerComment(comment))
    .map((comment) => {
      if (typeof comment === "string") {
        return { id: null, body: comment };
      }

      return {
        id: comment?.id ?? comment?.comment_id ?? null,
        body: commentBody(comment)
      };
    });
}

function isDaemonMarkerComment(comment) {
  const body = commentBody(comment);
  return /<!--\s*fizzy-symphony-marker\s*-->/u.test(body) && /fizzy-symphony:[a-z-]+:v1/u.test(body);
}

function isDaemonTag(tag) {
  // Deliberately narrow: human dispatch tags like agent-rerun and unknown agent-* tags stay in digest input.
  return tag === "agent-claimed" || tag.startsWith("agent-completed-") || tag.startsWith("agent-completion-failed-");
}
