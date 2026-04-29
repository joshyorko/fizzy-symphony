import { normalizeTag } from "./validation.js";
import { cardDigest } from "./domain.js";

const DEFAULT_ALLOWED_CARD_OVERRIDES = {
  backend: false,
  model: false,
  workspace: false,
  persona: false,
  priority: true,
  completion: false
};

const TERMINAL_CLAIM_STATUSES = new Set(["released", "completed", "failed", "cancelled", "lost"]);
const ROUTE_FIELDS = ["backend", "model", "workspace", "persona", "priority", "completion"];

export function routeCard({
  board,
  card,
  routes,
  config,
  activeClaims = [],
  completedMarkers = [],
  completionFailureMarkers = []
}) {
  const tags = normalizedTags(card);
  const rerunRequested = tags.includes("agent-rerun");
  const boardId = getBoardId(board, card);
  const columnId = getColumnId(card);

  if (isGoldenTicket(card)) {
    return ignoreDecision({ reason: "golden-ticket", card, rerunRequested });
  }

  if (!isWatchedBoard(boardId, config, board)) {
    return ignoreDecision({ reason: "unwatched-board", card, rerunRequested });
  }

  if (isClosed(card)) {
    return ignoreDecision({ reason: "closed", card, rerunRequested });
  }

  if (isPostponed(card) && !config?.routing?.allow_postponed_cards) {
    return ignoreDecision({ reason: "postponed", card, rerunRequested });
  }

  const route = findRoute(routes, boardId, columnId);
  if (!route) {
    return ignoreDecision({ reason: "no-route", card, rerunRequested });
  }

  if (hasLiveUnexpiredClaim(activeClaims, card)) {
    return ignoreDecision({ reason: "live-claim", card, route, rerunRequested });
  }

  if (!rerunRequested && hasNoRepeatCompletionMarker(completedMarkers, card, route)) {
    return ignoreDecision({ reason: "no-repeat-completion", card, route, rerunRequested });
  }

  if (!rerunRequested && hasCurrentCompletionFailureMarker(completionFailureMarkers, card, route)) {
    return ignoreDecision({ reason: "completion-failure", card, route, rerunRequested });
  }

  const parsed = parseCardOverrides(tags, board, card);
  if (parsed.error) {
    return failValidationDecision({ card, route, issue: parsed.error, rerunRequested });
  }

  for (const field of ROUTE_FIELDS) {
    if (Object.hasOwn(parsed.overrides, field) && !isOverrideAllowed(field, route, config)) {
      return failValidationDecision({
        card,
        route,
        rerunRequested,
        issue: {
          code: "CARD_OVERRIDE_NOT_ALLOWED",
          message: `Card override tag is not allowed for ${field}.`,
          details: {
            field,
            tags: parsed.override_tags[field] ?? []
          }
        }
      });
    }
  }

  const effectiveRoute = resolveEffectiveRoute({ route, boardId, config, overrides: parsed.overrides });
  const validation = validateEffectiveRoute(effectiveRoute, config, parsed);
  if (validation) {
    return failValidationDecision({ card, route, issue: validation, rerunRequested });
  }

  return {
    action: "spawn",
    spawn: true,
    reason: "eligible",
    card,
    route: effectiveRoute,
    source_route: route,
    overrides: parsed.overrides,
    override_tags: parsed.override_tags,
    rerun_requested: rerunRequested,
    explicit_priority: Object.hasOwn(parsed.overrides, "priority") ? parsed.overrides.priority : undefined
  };
}

export function sortDispatchCandidates(decisions) {
  return [...(decisions ?? [])]
    .filter((decision) => decision?.action === "spawn" || decision?.spawn === true)
    .sort(compareDispatchCandidates);
}

function compareDispatchCandidates(left, right) {
  return compareNumber(explicitPriorityRank(left), explicitPriorityRank(right)) ||
    compareNumber(priorityValue(left), priorityValue(right)) ||
    compareNumber(cardPriorityValue(left.card), cardPriorityValue(right.card)) ||
    compareNumber(lastActiveAt(left.card), lastActiveAt(right.card)) ||
    compareNumber(cardNumber(left.card), cardNumber(right.card));
}

function explicitPriorityRank(decision) {
  return hasExplicitPriority(decision) ? 0 : 1;
}

function priorityValue(decision) {
  return hasExplicitPriority(decision) ? Number(decision.explicit_priority ?? decision.overrides?.priority) : Number.POSITIVE_INFINITY;
}

function hasExplicitPriority(decision) {
  return Number.isFinite(Number(decision?.explicit_priority ?? decision?.overrides?.priority));
}

function cardPriorityValue(card) {
  for (const field of ["priority", "order", "position"]) {
    const value = Number(card?.[field]);
    if (Number.isFinite(value)) return value;
  }

  const priorityName = String(card?.priority ?? "").toLowerCase();
  const named = { urgent: 0, high: 1, medium: 3, low: 5 };
  return Object.hasOwn(named, priorityName) ? named[priorityName] : Number.POSITIVE_INFINITY;
}

function lastActiveAt(card) {
  const parsed = Date.parse(card?.last_active_at ?? card?.updated_at ?? "");
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function cardNumber(card) {
  const number = Number(card?.number);
  return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY;
}

function compareNumber(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseCardOverrides(tags, board, card) {
  const families = new Map();

  for (const tag of tags) {
    const parsed = parseOverrideTag(tag, board, card);
    if (!parsed) continue;
    if (parsed.error) return { error: parsed.error };

    const values = families.get(parsed.field) ?? new Map();
    const existing = values.get(parsed.key) ?? { value: parsed.value, tags: [] };
    existing.tags.push(tag);
    values.set(parsed.key, existing);
    families.set(parsed.field, values);
  }

  const overrides = {};
  const overrideTags = {};
  for (const [field, values] of families.entries()) {
    if (values.size > 1) {
      const tagsForConflict = [...values.values()].flatMap((entry) => entry.tags);
      return {
        error: {
          code: `CONFLICTING_${field.toUpperCase()}_TAGS`,
          message: `Card has conflicting ${field} tags.`,
          details: { field, tags: tagsForConflict }
        }
      };
    }

    const selected = values.values().next().value;
    overrides[field] = selected.value;
    overrideTags[field] = selected.tags;
  }

  return { overrides, override_tags: overrideTags };
}

function parseOverrideTag(tag, board, card) {
  if (tag === "codex" || tag === "backend-codex") {
    return { field: "backend", key: "codex", value: "codex" };
  }

  if (tag.startsWith("backend-")) {
    return invalidTag("INVALID_BACKEND_TAG", "Only Codex backend card overrides are valid.", tag, board, card);
  }

  if (tag.startsWith("model-")) {
    const value = tagValue(tag, "model-");
    if (!value) return invalidTag("INVALID_MODEL_TAG", "Model override tags require a model slug.", tag, board, card);
    return { field: "model", key: value, value };
  }

  if (tag.startsWith("workspace-")) {
    const value = tagValue(tag, "workspace-");
    if (!value) return invalidTag("INVALID_WORKSPACE_TAG", "Workspace override tags require a workspace name.", tag, board, card);
    return { field: "workspace", key: value, value };
  }

  if (tag.startsWith("persona-")) {
    const value = tagValue(tag, "persona-");
    if (!value) return invalidTag("INVALID_PERSONA_TAG", "Persona override tags require a persona name.", tag, board, card);
    return { field: "persona", key: value, value };
  }

  if (tag.startsWith("priority-")) {
    const value = tagValue(tag, "priority-");
    if (!/^[1-5]$/u.test(value)) {
      return invalidTag("INVALID_PRIORITY_TAG", "Priority override tags must be priority-1 through priority-5.", tag, board, card);
    }
    return { field: "priority", key: value, value: Number(value) };
  }

  if (tag === "complete-close") {
    return { field: "completion", key: "close", value: { policy: "close" } };
  }

  if (tag === "complete-comment-once") {
    return { field: "completion", key: "comment_once", value: { policy: "comment_once" } };
  }

  if (tag.startsWith("complete-move-to-")) {
    return parseMoveToCompletionOverride(tag, board, card);
  }

  if (tag.startsWith("complete-")) {
    return invalidTag("INVALID_COMPLETION_TAG", "Completion override tag is not supported.", tag, board, card);
  }

  return null;
}

function parseMoveToCompletionOverride(tag, board, card) {
  const slug = tag.slice("complete-move-to-".length);
  if (!slug) {
    return invalidTag("MISSING_COMPLETION_TARGET", "Move-to completion override tags require a target column.", tag, board, card);
  }

  const matches = (board?.columns ?? []).filter((column) => completionSlug(column.name) === slug);
  if (matches.length === 0) {
    return invalidTag("MISSING_COMPLETION_TARGET", "Move-to completion override target column does not exist.", tag, board, card);
  }
  if (matches.length > 1) {
    return invalidTag("DUPLICATE_COMPLETION_COLUMN_SLUG", "Move-to completion override matches multiple columns.", tag, board, card, {
      column_ids: matches.map((column) => column.id)
    });
  }

  const target = matches[0];
  return {
    field: "completion",
    key: `move_to_column:${target.id}`,
    value: { policy: "move_to_column", target_column_id: target.id, target_column_name: target.name }
  };
}

function invalidTag(code, message, tag, board, card, details = {}) {
  return {
    error: {
      code,
      message,
      details: {
        board_id: getBoardId(board, card),
        card_id: card?.id,
        tag,
        ...details
      }
    }
  };
}

function resolveEffectiveRoute({ route, boardId, config, overrides }) {
  const boardDefaults = defaultsForBoard(config, boardId);
  const effective = {
    ...route,
    backend: route.backend ?? boardDefaults.backend ?? config?.agent?.default_backend ?? "codex",
    model: route.model ?? boardDefaults.model ?? config?.agent?.default_model ?? "",
    workspace: route.workspace ?? boardDefaults.workspace ?? "app",
    persona: route.persona ?? boardDefaults.persona ?? config?.agent?.default_persona ?? "repo-agent",
    priority: route.priority ?? boardDefaults.priority,
    completion: route.completion
  };

  for (const [field, value] of Object.entries(overrides)) {
    effective[field] = value;
  }

  return effective;
}

function validateEffectiveRoute(effectiveRoute, config, parsed) {
  const workspaces = config?.workspaces?.registry;
  if (effectiveRoute.workspace && workspaces && !Object.hasOwn(workspaces, effectiveRoute.workspace)) {
    return {
      code: "UNKNOWN_WORKSPACE",
      message: `Unknown workspace: ${effectiveRoute.workspace}.`,
      details: {
        workspace: effectiveRoute.workspace,
        tags: parsed.override_tags.workspace ?? []
      }
    };
  }

  const allowedModels = config?.routing?.allowed_models ?? config?.agent?.allowed_models;
  if (Array.isArray(allowedModels) && effectiveRoute.model && !allowedModels.includes(effectiveRoute.model)) {
    return {
      code: "UNKNOWN_MODEL",
      message: `Unknown model: ${effectiveRoute.model}.`,
      details: {
        model: effectiveRoute.model,
        tags: parsed.override_tags.model ?? []
      }
    };
  }

  return null;
}

function isOverrideAllowed(field, route, config) {
  const allowed = { ...DEFAULT_ALLOWED_CARD_OVERRIDES, ...(route.allowed_card_overrides ?? {}) };
  if (field === "completion") {
    return allowed.completion === true && config?.completion?.allow_card_completion_override === true;
  }
  return allowed[field] === true;
}

function findRoute(routes, boardId, columnId) {
  return (routes ?? []).find((route) => {
    return route.board_id === boardId && route.source_column_id === columnId;
  }) ?? null;
}

function hasLiveUnexpiredClaim(claims, card) {
  const now = Date.now();
  return (claims ?? []).some((claim) => {
    if (!matchesCard(claim, card)) return false;
    if (TERMINAL_CLAIM_STATUSES.has(claim.status)) return false;
    if (claim.expired === true) return false;
    if (!claim.expires_at) return true;

    const expiresAt = Date.parse(claim.expires_at);
    return !Number.isFinite(expiresAt) || expiresAt > now;
  });
}

function hasNoRepeatCompletionMarker(markers, card, route) {
  const currentCardDigest = cardDigest(card, route);
  return (markers ?? []).some((marker) => {
    if (!matchesCard(marker, card)) return false;
    if (!matchesCurrentRouteFingerprint(marker, route)) return false;
    if (!markerBlocksCurrentDigest(marker, currentCardDigest, route)) return false;
    return marker.no_repeat !== false;
  });
}

function hasCurrentCompletionFailureMarker(markers, card, route) {
  const currentCardDigest = cardDigest(card, route);
  return (markers ?? []).some((marker) => {
    if (marker.resolved === true) return false;
    if (!matchesCard(marker, card)) return false;
    if (!matchesCurrentRouteFingerprint(marker, route)) return false;
    return markerBlocksCurrentDigest(marker, currentCardDigest, route);
  });
}

function matchesCard(record, card) {
  const recordCardId = record?.card_id ?? record?.card?.id;
  return !recordCardId || recordCardId === card?.id;
}

function matchesRoute(record, route) {
  if (record?.route_id) return record.route_id === route.id;
  if (record?.route_fingerprint) return record.route_fingerprint === route.fingerprint;
  return false;
}

function matchesCurrentRouteFingerprint(record, route) {
  if (record?.route_fingerprint) return record.route_fingerprint === route.fingerprint;
  return matchesRoute(record, route);
}

function markerBlocksCurrentDigest(marker, currentCardDigest, route) {
  if (!marker?.card_digest) return true;
  if (marker.card_digest === currentCardDigest) return true;
  return !routeAllowsRerunOnChange(route);
}

function routeAllowsRerunOnChange(route) {
  return route?.rerun_policy?.mode === "explicit_tag_or_route_change" ||
    route?.rerun_policy?.mode === "explicit_tag_or_content_change" ||
    route?.rerun_policy?.on_card_change === true ||
    route?.rerun?.on_card_change === true;
}

function ignoreDecision({ reason, card, route, rerunRequested }) {
  return {
    action: "ignore",
    spawn: false,
    reason,
    card,
    route,
    rerun_requested: rerunRequested
  };
}

function failValidationDecision({ card, route, issue, rerunRequested }) {
  const details = {
    card_id: card?.id,
    card_number: card?.number,
    route_id: route?.id,
    route_fingerprint: route?.fingerprint,
    ...issue.details
  };

  return {
    action: "fail-validation",
    spawn: false,
    reason: "validation-failed",
    code: issue.code,
    message: issue.message,
    details,
    card,
    route,
    rerun_requested: rerunRequested,
    comment: {
      body: routeValidationCommentBody(issue.code, issue.message, details)
    }
  };
}

function routeValidationCommentBody(code, message, details) {
  return [
    "fizzy-symphony:route-validation-failed:v1",
    "",
    message,
    "",
    "```json",
    canonicalJson({ code, ...details }),
    "```"
  ].join("\n");
}

function isWatchedBoard(boardId, config, board) {
  const entries = config?.boards?.entries;
  if (Array.isArray(entries) && entries.length > 0) {
    return entries.some((entry) => entry.id === boardId && entry.enabled !== false);
  }
  return board?.id === boardId;
}

function defaultsForBoard(config, boardId) {
  return (config?.boards?.entries ?? []).find((entry) => entry.id === boardId)?.defaults ?? {};
}

function isGoldenTicket(card) {
  return card?.golden === true;
}

function isClosed(card) {
  return card?.closed === true ||
    Boolean(card?.closed_at) ||
    Boolean(card?.archived_at) ||
    String(card?.status ?? "").toLowerCase() === "closed";
}

function isPostponed(card) {
  if (card?.postponed === true) return true;
  if (!card?.postponed_until) return false;

  const postponedUntil = Date.parse(card.postponed_until);
  return !Number.isFinite(postponedUntil) || postponedUntil > Date.now();
}

function normalizedTags(card) {
  return [...new Set((card?.tags ?? []).map(normalizeTag).filter(Boolean))];
}

function getBoardId(board, card) {
  return card?.board_id ?? card?.board?.id ?? board?.id ?? null;
}

function getColumnId(card) {
  return card?.column_id ?? card?.column?.id ?? null;
}

function tagValue(tag, prefix) {
  return tag.startsWith(prefix) && tag.length > prefix.length ? tag.slice(prefix.length) : null;
}

function completionSlug(name) {
  return String(name).trim().toLowerCase().replace(/[\s-]+/gu, "-");
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
