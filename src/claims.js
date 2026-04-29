import { randomUUID } from "node:crypto";

import { FizzySymphonyError } from "./errors.js";
import { commentBody } from "./fizzy-normalize.js";

export const CLAIM_MARKER = "fizzy-symphony:claim:v1";

const MARKER_SENTINEL = "<!-- fizzy-symphony-marker -->";
const DEFAULT_LEASE_MS = 900000;
const DEFAULT_STEAL_GRACE_MS = 30000;
const DEFAULT_MAX_CLOCK_SKEW_MS = 30000;
const TERMINAL_STATUSES = new Set(["released", "completed", "failed", "cancelled", "lost"]);
const VALID_STATUSES = new Set(["claimed", "renewed", ...TERMINAL_STATUSES]);
const REQUIRED_FIELDS = [
  "marker",
  "claim_id",
  "card_id",
  "board_id",
  "route_id",
  "route_fingerprint",
  "workspace_key",
  "workspace_identity_digest",
  "instance_id",
  "attempt_id",
  "run_id",
  "started_at",
  "renewed_at",
  "expires_at",
  "daemon_version",
  "status"
];

export function createClaimMarker({ claim = {}, route = {}, card = {}, instance = {}, workspace = {}, now = new Date() } = {}) {
  const issuedAt = toIsoString(now, "now", "INVALID_CLAIM_MARKER");
  const payload = omitUndefined({
    marker: CLAIM_MARKER,
    claim_id: claim.claim_id ?? claim.id ?? `claim_${randomUUID()}`,
    status: claim.status ?? "claimed",
    card_id: claim.card_id ?? card.id,
    board_id: claim.board_id ?? card.board_id ?? card.board?.id ?? route.board_id,
    card_digest: claim.card_digest ?? card.digest,
    route_id: claim.route_id ?? route.id,
    route_fingerprint: claim.route_fingerprint ?? route.fingerprint,
    workspace_key: claim.workspace_key ?? workspace.workspace_key ?? workspace.key ?? workspace.id,
    workspace_identity_digest: claim.workspace_identity_digest ??
      workspace.workspace_identity_digest ??
      workspace.identity_digest ??
      workspace.identityDigest,
    instance_id: claim.instance_id ?? instance.id,
    attempt_id: claim.attempt_id ?? claim.attemptId ?? `attempt_${randomUUID()}`,
    run_id: claim.run_id ?? claim.runId ?? `run_${randomUUID()}`,
    started_at: toIsoString(claim.started_at ?? claim.startedAt ?? now, "started_at", "INVALID_CLAIM_MARKER"),
    renewed_at: toIsoString(claim.renewed_at ?? claim.renewedAt ?? now, "renewed_at", "INVALID_CLAIM_MARKER"),
    expires_at: claimExpiresAt(claim, now),
    daemon_version: claim.daemon_version ?? instance.daemon_version ?? instance.version ?? "unknown",
    marker_sequence: claim.marker_sequence ?? claim.sequence
  });

  validateClaimPayload(payload, "INVALID_CLAIM_MARKER");

  return {
    body: markerBody(payload),
    claim: payload
  };
}

export function createReleaseMarker({ claim = {}, status = "released", now = new Date() } = {}) {
  if (!TERMINAL_STATUSES.has(status)) {
    throw new FizzySymphonyError("INVALID_CLAIM_STATUS", "Claim release marker requires a terminal status.", { status });
  }

  return createClaimMarker({
    claim: {
      ...claim,
      status,
      started_at: claim.started_at,
      expires_at: claim.expires_at ?? claim.lease_expires_at
    },
    route: { id: claim.route_id, fingerprint: claim.route_fingerprint },
    card: { id: claim.card_id, board_id: claim.board_id, digest: claim.card_digest },
    instance: { id: claim.instance_id, daemon_version: claim.daemon_version },
    workspace: {
      workspace_key: claim.workspace_key,
      workspace_identity_digest: claim.workspace_identity_digest
    },
    now
  });
}

export function parseClaimMarker(body) {
  const match = String(body).match(
    /<!-- fizzy-symphony-marker -->\s*fizzy-symphony:claim:v1\s*```json\s*([\s\S]*?)\s*```/u
  );
  if (!match) {
    throw new FizzySymphonyError("MALFORMED_CLAIM_MARKER", "Claim marker Markdown block was not found.");
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    throw new FizzySymphonyError("MALFORMED_CLAIM_MARKER", "Claim marker is not valid JSON.", {
      cause: error.message
    });
  }

  if (parsed?.lease_expires_at && !parsed.expires_at) {
    parsed.expires_at = parsed.lease_expires_at;
  }
  delete parsed.lease_expires_at;

  validateClaimPayload(parsed, "MALFORMED_CLAIM_MARKER");
  return parsed;
}

export function readClaims(comments = []) {
  const claims = [];

  for (const [index, comment] of comments.entries()) {
    const body = commentBody(comment);
    if (!body.includes(CLAIM_MARKER)) continue;

    const parsed = parseClaimMarker(body);
    claims.push(omitUndefined({
      ...parsed,
      comment_id: typeof comment === "object" ? comment.id : undefined,
      comment_created_at: commentCreatedAt(comment),
      event_index: index
    }));
  }

  return claims.sort(compareClaimEvents);
}

export function applyClaimEventLog(commentsOrClaims = []) {
  const events = eventsFrom(commentsOrClaims);
  const byClaimId = new Map();

  for (const event of events) {
    const previous = byClaimId.get(event.claim_id);
    const merged = omitUndefined({
      ...(previous ?? {}),
      ...event,
      events: [...(previous?.events ?? []), event],
      terminal: TERMINAL_STATUSES.has(event.status),
      active: !TERMINAL_STATUSES.has(event.status)
    });
    byClaimId.set(event.claim_id, merged);
  }

  return [...byClaimId.values()].sort(compareClaimStates);
}

export function selectActiveClaim(claims = [], { cardId, card_id, now = new Date() } = {}) {
  const nowMs = toTimeMs(now, "now", "INVALID_CLAIM_TIME");
  const candidates = activeClaimsForCard(claims, cardId ?? card_id)
    .filter((candidate) => claimExpiresAtMs(candidate) > nowMs)
    .sort(compareActiveClaimOrder);

  return candidates[0] ?? null;
}

export function canAcquireClaim(claims = [], options = {}) {
  const activeClaim = selectActiveClaim(claims, options);
  if (activeClaim) {
    return { ok: false, reason: "active_claim", activeClaim };
  }

  const expectedCardId = options.cardId ?? options.card_id;
  const nowMs = toTimeMs(options.now ?? new Date(), "now", "INVALID_CLAIM_TIME");
  const stealGraceMs = Number(options.stealGraceMs ?? options.steal_grace_ms ?? 0);
  const liveClaims = activeClaimsForCard(claims, expectedCardId).sort(compareActiveClaimOrder);

  if (liveClaims.length === 0) {
    return { ok: true, reason: "no_active_claim" };
  }

  const graceBlockedClaim = liveClaims.find((candidate) => nowMs <= claimExpiresAtMs(candidate) + stealGraceMs);
  if (graceBlockedClaim) {
    return { ok: false, reason: "claim_steal_grace", activeClaim: graceBlockedClaim };
  }

  return { ok: true, reason: "expired_stealable" };
}

export function inspectClaimMarkers(comments = [], { instanceId, instance_id, now = new Date() } = {}) {
  const events = [];
  const warnings = [];
  const currentInstanceId = instanceId ?? instance_id;
  const nowMs = toTimeMs(now, "now", "INVALID_CLAIM_TIME");

  for (const [index, comment] of comments.entries()) {
    const body = commentBody(comment);
    if (!body.includes(CLAIM_MARKER)) continue;

    try {
      events.push(omitUndefined({
        ...parseClaimMarker(body),
        comment_id: typeof comment === "object" ? comment.id : undefined,
        comment_created_at: commentCreatedAt(comment),
        event_index: index
      }));
    } catch (error) {
      warnings.push({
        code: "CLAIM_MARKER_MALFORMED",
        comment_id: typeof comment === "object" ? comment.id : undefined,
        message: error.message
      });
    }
  }

  const orderedEvents = events.sort(compareClaimEvents);
  const reduced = applyClaimEventLog(orderedEvents);

  const liveSelfClaimWarnings = reduced.filter((claim) => (
    claim.instance_id === currentInstanceId &&
    isLiveStatus(claim.status) &&
    claimExpiresAtMs(claim) > nowMs
  ));

  return {
    claims: reduced,
    events: orderedEvents,
    warnings: [
      ...warnings,
      ...liveSelfClaimWarnings.map((claim) => ({
        code: "CLAIM_SELF_LIVE_ON_STARTUP",
        claim_id: claim.claim_id,
        card_id: claim.card_id
      }))
    ],
    recoverable_expired_self_claims: reduced.filter((claim) => (
      claim.instance_id === currentInstanceId &&
      isLiveStatus(claim.status) &&
      claimExpiresAtMs(claim) <= nowMs
    )),
    live_self_claim_warnings: liveSelfClaimWarnings,
    other_live_claims: reduced.filter((claim) => (
      claim.instance_id !== currentInstanceId &&
      isLiveStatus(claim.status) &&
      claimExpiresAtMs(claim) > nowMs
    )),
    terminal_claims: reduced.filter((claim) => TERMINAL_STATUSES.has(claim.status))
  };
}

export function createBoardClaimStore({
  fizzy,
  status,
  sleep = defaultSleep,
  ids = {}
} = {}) {
  if (!fizzy) {
    throw new FizzySymphonyError("CLAIM_STORE_REQUIRES_FIZZY", "Board claim store requires a Fizzy client.");
  }

  return {
    async acquire({ config = {}, card = {}, route = {}, workspace = {}, now = new Date() } = {}) {
      const options = claimOptions(config);
      const nowValue = toDate(now);
      const initialComments = await listCardComments(fizzy, { card });
      let claims = applyClaimEventLog(initialComments);
      const activeClaim = selectActiveClaim(claims, { cardId: card.id, now: nowValue });
      if (activeClaim) {
        recordClaim(status, { ...activeClaim, status: "blocked", blocked_by_claim_id: activeClaim.claim_id });
        return { acquired: false, reason: "active_claim", live_claim: activeClaim };
      }

      let reason = "no_active_claim";
      const expiredClaims = activeClaimsForCard(claims, card.id)
        .filter((claim) => claimExpiresAtMs(claim) <= nowValue.getTime())
        .sort(compareActiveClaimOrder);

      if (expiredClaims.length > 0) {
        reason = "expired_stealable";
        if (options.stealGraceMs > 0) {
          await sleep(options.stealGraceMs);
          const rereadAfterGrace = await listCardComments(fizzy, { card });
          claims = applyClaimEventLog(rereadAfterGrace);
          const renewedClaim = selectActiveClaim(claims, { cardId: card.id, now: nowValue });
          if (renewedClaim) {
            recordClaim(status, {
              ...renewedClaim,
              status: "blocked",
              reason: "active_claim_after_grace",
              blocked_by_claim_id: renewedClaim.claim_id
            });
            return { acquired: false, reason: "active_claim_after_grace", live_claim: renewedClaim };
          }
        }
      }

      const marker = createClaimMarker({
        claim: {
          claim_id: callId(ids.claimId, "claim"),
          attempt_id: callId(ids.attemptId, "attempt"),
          run_id: callId(ids.runId, "run"),
          lease_ms: options.leaseMs
        },
        route,
        card,
        instance: instanceFromConfig(config),
        workspace,
        now: nowValue
      });

      await postCardComment(fizzy, { card, body: marker.body });
      const rereadComments = await listCardComments(fizzy, { card });
      const rereadClaims = applyClaimEventLog(rereadComments);
      const winner = selectClaimWinner(rereadClaims, {
        cardId: card.id,
        now: nowValue,
        maxClockSkewMs: options.maxClockSkewMs
      });

      if (!winner || winner.claim_id !== marker.claim.claim_id) {
        await postLostClaim(fizzy, { card, claim: marker.claim, now: nowValue });
        const lost = {
          ...marker.claim,
          status: "lost",
          live_claim: winner ?? null,
          lost_to_claim_id: winner?.claim_id
        };
        recordClaim(status, lost);
        return { acquired: false, reason: "lost_claim", claim: lost, live_claim: winner ?? null };
      }

      await assignAndWatch(fizzy, { config, card });
      recordClaim(status, { ...marker.claim, status: "claimed", stolen_claims: expiredClaims });
      return { acquired: true, reason, claim: marker.claim, stolen_claims: expiredClaims };
    },

    async renew({ config = {}, card = {}, claim = {}, now = new Date() } = {}) {
      const options = claimOptions(config);
      const nowValue = toDate(now);
      const renewedClaim = {
        ...claim,
        status: "renewed",
        renewed_at: nowValue.toISOString(),
        expires_at: new Date(nowValue.getTime() + options.leaseMs).toISOString()
      };
      const marker = createClaimMarker({
        claim: renewedClaim,
        route: { id: claim.route_id, fingerprint: claim.route_fingerprint },
        card: { id: claim.card_id ?? card.id, board_id: claim.board_id ?? card.board_id, digest: claim.card_digest ?? card.digest },
        instance: { id: claim.instance_id, daemon_version: claim.daemon_version },
        workspace: {
          workspace_key: claim.workspace_key,
          workspace_identity_digest: claim.workspace_identity_digest
        },
        now: nowValue
      });

      try {
        await postCardComment(fizzy, { card: claimCard(card, marker.claim), body: marker.body });
        recordClaim(status, marker.claim);
        return { renewed: true, claim: marker.claim };
      } catch (error) {
        const failed = renewalFailure(marker.claim, error);
        recordClaim(status, failed);
        return { renewed: false, claim: failed, error };
      }
    },

    async release({ config = {}, card = {}, claim = {}, status: releaseStatus = "released", now = new Date() } = {}) {
      const nowValue = toDate(now);
      let marker;
      try {
        marker = createReleaseMarker({ claim, status: releaseStatus, now: nowValue });
        await postCardComment(fizzy, { card: claimCard(card, marker.claim), body: marker.body });
        recordClaim(status, marker.claim);
        return { released: true, claim: marker.claim };
      } catch (error) {
        const failed = releaseFailure(marker?.claim ?? claim, releaseStatus, error, config);
        recordClaim(status, failed);
        return { released: false, claim: failed, error };
      }
    },

    async expire({ claim = {}, now = new Date() } = {}) {
      const expired = claimExpiresAtMs(claim) <= toTimeMs(now, "now", "INVALID_CLAIM_TIME");
      if (expired) {
        recordClaim(status, { ...claim, status: "expired", expired: true });
      }
      return { expired, claim };
    }
  };
}

function activeClaimsForCard(claims, cardId) {
  return claimStates(claims)
    .filter((candidate) => claimMatches(candidate, cardId))
    .filter((candidate) => isLiveStatus(candidate.status));
}

function selectClaimWinner(claims, { cardId, now = new Date(), maxClockSkewMs = DEFAULT_MAX_CLOCK_SKEW_MS } = {}) {
  const nowMs = toTimeMs(now, "now", "INVALID_CLAIM_TIME");
  const candidates = activeClaimsForCard(claims, cardId)
    .filter((candidate) => claimExpiresAtMs(candidate) > nowMs)
    .sort((a, b) => compareClaimWinner(a, b, maxClockSkewMs));

  return candidates[0] ?? null;
}

function compareClaimWinner(a, b, maxClockSkewMs) {
  const startedDelta = toTimeMs(a.started_at, "started_at", "MALFORMED_CLAIM_MARKER") -
    toTimeMs(b.started_at, "started_at", "MALFORMED_CLAIM_MARKER");
  if (Math.abs(startedDelta) <= maxClockSkewMs) {
    return String(a.claim_id).localeCompare(String(b.claim_id));
  }
  return startedDelta || String(a.claim_id).localeCompare(String(b.claim_id));
}

async function postLostClaim(fizzy, { card, claim, now }) {
  try {
    const lost = createReleaseMarker({ claim, status: "lost", now });
    await postCardComment(fizzy, { card, body: lost.body });
    return lost.claim;
  } catch {
    return null;
  }
}

async function assignAndWatch(fizzy, { config, card }) {
  if (config.claims?.assign_on_claim && config.fizzy?.bot_user_id) {
    await maybeCall(fizzy, ["assignCard", "assignToCard", "addAssignee"], {
      card,
      cardId: card.id,
      card_id: card.id,
      userId: config.fizzy.bot_user_id,
      user_id: config.fizzy.bot_user_id
    });
  }

  if (config.claims?.watch_on_claim) {
    await maybeCall(fizzy, ["watchCard", "addWatcher"], {
      card,
      cardId: card.id,
      card_id: card.id
    });
  }
}

async function listCardComments(fizzy, { card }) {
  if (typeof fizzy.listComments === "function") return fizzy.listComments({ card, cardId: card.id, card_id: card.id });
  if (typeof fizzy.listCardComments === "function") return fizzy.listCardComments({ card, cardId: card.id, card_id: card.id });
  if (typeof fizzy.getCardComments === "function") return fizzy.getCardComments({ card, cardId: card.id, card_id: card.id });
  throw new FizzySymphonyError("FIZZY_COMMENTS_UNAVAILABLE", "Fizzy client does not support listing card comments.");
}

async function postCardComment(fizzy, { card, body }) {
  if (typeof fizzy.postComment === "function") return fizzy.postComment({ card, cardId: card.id, card_id: card.id, body });
  if (typeof fizzy.createComment === "function") return fizzy.createComment({ card, cardId: card.id, card_id: card.id, body });
  if (typeof fizzy.createCardComment === "function") return fizzy.createCardComment({ card, cardId: card.id, card_id: card.id, body });
  if (typeof fizzy.postStructuredComment === "function") return fizzy.postStructuredComment({ card, cardId: card.id, card_id: card.id, body });
  throw new FizzySymphonyError("FIZZY_COMMENTS_UNAVAILABLE", "Fizzy client does not support creating card comments.");
}

async function maybeCall(target, methodNames, payload) {
  for (const methodName of methodNames) {
    if (typeof target[methodName] === "function") {
      return target[methodName](payload);
    }
  }
  return null;
}

function recordClaim(status, claim) {
  return status?.recordClaim?.(claim) ?? null;
}

function claimOptions(config) {
  return {
    leaseMs: positiveNumber(config.claims?.lease_ms, DEFAULT_LEASE_MS),
    stealGraceMs: nonNegativeNumber(config.claims?.steal_grace_ms, DEFAULT_STEAL_GRACE_MS),
    maxClockSkewMs: nonNegativeNumber(config.claims?.max_clock_skew_ms, DEFAULT_MAX_CLOCK_SKEW_MS)
  };
}

function instanceFromConfig(config) {
  return {
    id: config.instance?.id,
    daemon_version: config.instance?.daemon_version ?? config.daemon_version ?? config.version ?? "unknown"
  };
}

function callId(factory, prefix) {
  return typeof factory === "function" ? factory() : `${prefix}_${randomUUID()}`;
}

function claimCard(card, claim) {
  return {
    ...card,
    id: card.id ?? claim.card_id,
    board_id: card.board_id ?? claim.board_id,
    digest: card.digest ?? claim.card_digest
  };
}

function renewalFailure(claim, error) {
  return {
    ...claim,
    status: "renew_failed",
    preserve_workspace: true,
    error: normalizeError(error)
  };
}

function releaseFailure(claim, desiredStatus, error) {
  return {
    ...claim,
    status: "release_failed",
    desired_status: desiredStatus,
    preserve_workspace: true,
    error: normalizeError(error)
  };
}

function normalizeError(error) {
  return {
    code: error?.code ?? "CLAIM_MARKER_WRITE_FAILED",
    message: error?.message ?? String(error)
  };
}

function markerBody(payload) {
  return [
    MARKER_SENTINEL,
    CLAIM_MARKER,
    "",
    "```json",
    canonicalJson(payload),
    "```"
  ].join("\n");
}

function validateClaimPayload(payload, code) {
  const missing = REQUIRED_FIELDS.filter((field) => payload?.[field] === undefined || payload?.[field] === null || payload?.[field] === "");
  if (payload?.marker !== CLAIM_MARKER || missing.length > 0) {
    throw new FizzySymphonyError(code, "Claim marker is missing required fields.", {
      marker: payload?.marker,
      missing
    });
  }
  if (!VALID_STATUSES.has(payload.status)) {
    throw new FizzySymphonyError(code, "Claim marker has an unsupported status.", { status: payload.status });
  }

  for (const field of ["started_at", "renewed_at", "expires_at"]) {
    toTimeMs(payload[field], field, code);
  }
}

function claimExpiresAt(claim, now) {
  if (claim.expires_at ?? claim.lease_expires_at) {
    return toIsoString(claim.expires_at ?? claim.lease_expires_at, "expires_at", "INVALID_CLAIM_MARKER");
  }

  const leaseMs = positiveNumber(claim.lease_ms ?? claim.leaseMs, DEFAULT_LEASE_MS, "INVALID_CLAIM_MARKER");
  return new Date(toTimeMs(now, "now", "INVALID_CLAIM_MARKER") + leaseMs).toISOString();
}

function claimExpiresAtMs(claim) {
  return toTimeMs(claim.expires_at ?? claim.lease_expires_at, "expires_at", "MALFORMED_CLAIM_MARKER");
}

function claimStates(claims) {
  if (!Array.isArray(claims)) return [];
  if (claims.every((claim) => Array.isArray(claim?.events))) {
    return [...claims].sort(compareClaimStates);
  }
  return applyClaimEventLog(claims);
}

function eventsFrom(commentsOrClaims) {
  if (!Array.isArray(commentsOrClaims)) return [];
  if (commentsOrClaims.some((entry) => typeof entry === "string" || Object.hasOwn(entry ?? {}, "body"))) {
    return readClaims(commentsOrClaims);
  }
  return [...commentsOrClaims].sort(compareClaimEvents);
}

function claimMatches(claim, cardId) {
  if (cardId && claim.card_id !== cardId) return false;
  return true;
}

function isLiveStatus(status) {
  return Boolean(status) && !TERMINAL_STATUSES.has(status);
}

function compareClaimEvents(a, b) {
  return compareTimestamp(a.comment_created_at, b.comment_created_at) ||
    compareSequence(a.marker_sequence, b.marker_sequence) ||
    String(a.claim_id).localeCompare(String(b.claim_id)) ||
    compareSequence(a.event_index, b.event_index);
}

function compareClaimStates(a, b) {
  return compareActiveClaimOrder(a, b) || compareTimestamp(a.comment_created_at, b.comment_created_at);
}

function compareActiveClaimOrder(a, b) {
  return compareTimestamp(a.started_at, b.started_at) || String(a.claim_id).localeCompare(String(b.claim_id));
}

function compareTimestamp(left, right) {
  const leftMs = Date.parse(left ?? "");
  const rightMs = Date.parse(right ?? "");
  const normalizedLeft = Number.isNaN(leftMs) ? Number.POSITIVE_INFINITY : leftMs;
  const normalizedRight = Number.isNaN(rightMs) ? Number.POSITIVE_INFINITY : rightMs;
  return normalizedLeft - normalizedRight;
}

function compareSequence(left, right) {
  const normalizedLeft = Number.isFinite(Number(left)) ? Number(left) : 0;
  const normalizedRight = Number.isFinite(Number(right)) ? Number(right) : 0;
  return normalizedLeft - normalizedRight;
}

function commentCreatedAt(comment) {
  if (!comment || typeof comment !== "object") return undefined;
  return comment.created_at ?? comment.createdAt ?? comment.updated_at ?? comment.updatedAt;
}

function toDate(value) {
  return new Date(toTimeMs(value, "now", "INVALID_CLAIM_TIME"));
}

function toIsoString(value, field, code) {
  return new Date(toTimeMs(value, field, code)).toISOString();
}

function toTimeMs(value, field, code) {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(time)) {
    throw new FizzySymphonyError(code, `Invalid claim timestamp: ${field}`, { field, value });
  }
  return time;
}

function positiveNumber(value, fallback, code = "INVALID_CLAIM_CONFIG") {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) {
    throw new FizzySymphonyError(code, "Claim duration must be a positive number.", { value });
  }
  return number;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0) {
    throw new FizzySymphonyError("INVALID_CLAIM_CONFIG", "Claim timing value must be a non-negative number.", { value });
  }
  return number;
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function omitUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
