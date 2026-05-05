import { createHmac, timingSafeEqual } from "node:crypto";

import { createEtagCache } from "./etag-cache.js";
import { FizzySymphonyError } from "./errors.js";

const DEFAULT_WEBHOOK_ACTIONS = [
  "card_assigned",
  "card_closed",
  "card_postponed",
  "card_auto_postponed",
  "card_board_changed",
  "card_published",
  "card_reopened",
  "card_sent_back_to_triage",
  "card_triaged",
  "card_unassigned",
  "comment_created"
];

const REDACTED_BODY_KEYS = new Set([
  "authorization",
  "api_key",
  "api_token",
  "auth_token",
  "secret",
  "signing_secret",
  "token",
  "webhook_secret",
  "webhook_signature"
]);

export class FizzyApiError extends Error {
  constructor(message, metadata = {}) {
    super(message);
    this.name = "FizzyApiError";
    this.status = metadata.status;
    this.metadata = metadata;
  }
}

export function createLegacyFizzyClient(options = {}) {
  const {
    config = {},
    normalize = (_resource, body) => body,
    etagCache = createEtagCache({ config })
  } = options;

  const transport = options.transport ?? createFetchTransport({
    config,
    fetch: options.fetch ?? globalThis.fetch
  });

  if (typeof transport !== "function") {
    throw new TypeError("createFizzyClient requires a transport function or fetch implementation.");
  }

  async function requestResource(resource, request) {
    const method = request.method ?? "GET";
    const useEtags = method === "GET" && config.polling?.use_etags !== false && etagCache;
    const headers = { ...(request.headers ?? {}) };
    let lookupResult = null;

    if (useEtags) {
      await etagCache.load();
      lookupResult = etagCache.lookup(resource);
      if (lookupResult.entry) {
        headers["If-None-Match"] = lookupResult.entry.etag;
      }
    }

    const response = await transport({
      method,
      path: request.path,
      query: request.query ?? {},
      headers,
      body: request.body
    });
    const status = Number(response?.status ?? response?.statusCode ?? 200);

    if (status === 304) {
      if (lookupResult?.entry) {
        etagCache.recordHit?.();
        return {
          status,
          ok: true,
          not_modified: true,
          resource,
          etag: lookupResult.entry.etag,
          snapshot: lookupResult.entry.snapshot,
          data: lookupResult.entry.snapshot,
          metadata: response?.metadata ?? {}
        };
      }

      etagCache?.recordInvalid?.();
      return {
        status,
        ok: false,
        not_modified: true,
        resource,
        etag: null,
        snapshot: null,
        data: null,
        metadata: response?.metadata ?? {}
      };
    }

    if (status < 200 || status >= 300) {
      throw apiError({ response, request: { method, path: request.path } });
    }

    if (lookupResult?.entry) {
      etagCache.recordMiss?.();
    }

    const body = response?.body ?? response?.data ?? null;
    const snapshot = normalize(resource, body);
    const etag = responseEtag(response);

    if (useEtags && typeof etag === "string" && etag.length > 0) {
      etagCache.set(resource, { etag, snapshot });
      await etagCache.save();
    }

    return {
      status,
      ok: true,
      not_modified: false,
      resource,
      etag: etag ?? null,
      snapshot,
      data: snapshot,
      metadata: response?.metadata ?? {}
    };
  }

  async function requestData(resource, request) {
    return (await requestResource(resource, request)).data;
  }

  async function writeResource(resource, request) {
    return (await requestResource(resource, request)).data;
  }

  function accountPath(path, account = config.fizzy?.account) {
    const segment = accountPathSegment(account);
    if (!segment) {
      throw new FizzySymphonyError("FIZZY_ACCOUNT_REQUIRED", "Fizzy account slug is required for this API route.");
    }
    return `/${encodePathPart(segment)}${path}`;
  }

  async function readBoards(account) {
    return requestResource(
      { type: "board_collection", id: account ?? config.fizzy?.account ?? "default" },
      { path: accountPath("/boards", account) }
    );
  }

  async function readBoard(boardId, account) {
    return requestResource(
      { type: "board", id: boardId },
      { path: accountPath(`/boards/${encodePathPart(boardId)}`, account) }
    );
  }

  async function getBoard(boardId, options = {}) {
    const board = await requestData(
      { type: "board", id: boardId },
      { path: accountPath(`/boards/${encodePathPart(boardId)}`, options.account) }
    );
    const hydrated = { ...(board ?? {}) };

    if (options.includeColumns !== false && !Array.isArray(hydrated.columns)) {
      hydrated.columns = await listColumns(boardId, { account: options.account });
    }

    if (options.includeCards !== false && !Array.isArray(hydrated.cards)) {
      hydrated.cards = await listCards({ account: options.account, query: { board_ids: [boardId] } });
    }

    return hydrated;
  }

  async function readColumns(boardId, options = {}) {
    return requestResource(
      { type: "column_collection", id: boardId },
      { path: accountPath(`/boards/${encodePathPart(boardId)}/columns`, options.account) }
    );
  }

  async function listColumns(boardId, options = {}) {
    return (await readColumns(boardId, options)).data;
  }

  async function readColumn({ board_id, boardId, column_id, columnId, account } = {}) {
    const resolvedBoardId = board_id ?? boardId;
    const resolvedColumnId = column_id ?? columnId;
    return requestResource(
      { type: "column", id: resolvedColumnId },
      {
        path: accountPath(
          `/boards/${encodePathPart(resolvedBoardId)}/columns/${encodePathPart(resolvedColumnId)}`,
          account
        )
      }
    );
  }

  async function readCards(options = {}) {
    const account = options.account;
    const query = options.query ?? omitKeys(options, ["account"]);
    return requestResource(
      { type: "card_collection", query },
      { path: accountPath("/cards", account), query }
    );
  }

  async function listCards(options = {}) {
    return (await readCards(options)).data;
  }

  async function discoverCandidates({ query = {}, config: candidateConfig = config } = {}) {
    const result = await readCards({ query });
    return {
      ...result,
      candidates: result.data,
      etag_cache: etagCache?.stats?.() ?? { hits: 0, misses: 0, invalid: 0 },
      config: candidateConfig
    };
  }

  async function readGoldenCards(options = {}) {
    const account = options.account;
    const query = { ...(options.query ?? omitKeys(options, ["account"])), indexed_by: "golden" };
    return requestResource(
      { type: "golden_card_collection", query },
      { path: accountPath("/cards", account), query }
    );
  }

  async function listGoldenCards(options = {}) {
    return (await readGoldenCards(options)).data;
  }

  async function readCard(card) {
    const cardNumber = cardNumberFrom(card);
    return requestResource(
      { type: "card", id: cardNumber },
      { path: accountPath(`/cards/${encodePathPart(cardNumber)}`, card?.account) }
    );
  }

  async function getCard(card) {
    return (await readCard(card)).data;
  }

  async function refreshCard({ card, route } = {}) {
    return getCard({ ...(card ?? {}), route });
  }

  async function refreshActiveCards({ activeRuns = [] } = {}) {
    const cards = [];
    for (const run of activeRuns) {
      const number = run.card_number ?? run.card?.number ?? run.card?.card_number;
      if (!number) continue;
      cards.push(await getCard(number));
    }
    return cards;
  }

  async function readComments(input = {}) {
    const cardNumber = cardNumberFrom(input);
    return requestResource(
      { type: "comment", id: cardNumber },
      { path: accountPath(`/cards/${encodePathPart(cardNumber)}/comments`, input.account) }
    );
  }

  async function listComments(input = {}) {
    return (await readComments(input)).data;
  }

  async function getComment(input = {}) {
    const cardNumber = cardNumberFrom(input);
    const commentId = input.comment_id ?? input.commentId ?? input.id;
    return requestData(
      { type: "comment", id: commentId },
      {
        path: accountPath(
          `/cards/${encodePathPart(cardNumber)}/comments/${encodePathPart(commentId)}`,
          input.account
        )
      }
    );
  }

  async function createComment(input = {}) {
    const cardNumber = cardNumberFrom(input);
    const result = await requestResource(
      { type: "comment_create", id: cardNumber },
      {
        method: "POST",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/comments`, input.account),
        body: { comment: { body: input.body ?? "" } }
      }
    );
    return responseDataWithLocation(result);
  }

  async function updateComment(input = {}) {
    const cardNumber = cardNumberFrom(input);
    const commentId = input.comment_id ?? input.commentId ?? input.id;
    return writeResource(
      { type: "comment_update", id: commentId },
      {
        method: "PUT",
        path: accountPath(
          `/cards/${encodePathPart(cardNumber)}/comments/${encodePathPart(commentId)}`,
          input.account
        ),
        body: { comment: { body: input.body ?? "" } }
      }
    );
  }

  async function deleteComment(input = {}) {
    const cardNumber = cardNumberFrom(input);
    const commentId = input.comment_id ?? input.commentId ?? input.id;
    return writeResource(
      { type: "comment_delete", id: commentId },
      {
        method: "DELETE",
        path: accountPath(
          `/cards/${encodePathPart(cardNumber)}/comments/${encodePathPart(commentId)}`,
          input.account
        )
      }
    );
  }

  async function createStep(input = {}) {
    const cardNumber = cardNumberFrom(input);
    return writeResource(
      { type: "step_create", id: cardNumber },
      {
        method: "POST",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/steps`, input.account),
        body: { step: omitUndefined({ content: input.content, completed: input.completed }) }
      }
    );
  }

  async function getStep(input = {}) {
    const cardNumber = cardNumberFrom(input);
    const stepId = input.step_id ?? input.stepId ?? input.id;
    return requestData(
      { type: "step", id: stepId },
      {
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/steps/${encodePathPart(stepId)}`, input.account)
      }
    );
  }

  async function listSteps(input = {}) {
    const card = await getCard(input);
    return card?.steps ?? [];
  }

  async function updateStep(input = {}) {
    const cardNumber = cardNumberFrom(input);
    const stepId = input.step_id ?? input.stepId ?? input.id;
    return writeResource(
      { type: "step_update", id: stepId },
      {
        method: "PUT",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/steps/${encodePathPart(stepId)}`, input.account),
        body: { step: omitUndefined({ content: input.content, completed: input.completed }) }
      }
    );
  }

  async function deleteStep(input = {}) {
    const cardNumber = cardNumberFrom(input);
    const stepId = input.step_id ?? input.stepId ?? input.id;
    return writeResource(
      { type: "step_delete", id: stepId },
      {
        method: "DELETE",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/steps/${encodePathPart(stepId)}`, input.account)
      }
    );
  }

  async function readTags(account) {
    return requestResource(
      { type: "tag", id: account ?? config.fizzy?.account ?? "default" },
      { path: accountPath("/tags", account) }
    );
  }

  async function listTags(account) {
    return (await readTags(account)).data;
  }

  async function getTag(tagId, options = {}) {
    return requestData(
      { type: "tag", id: tagId },
      { path: accountPath(`/tags/${encodePathPart(tagId)}`, options.account) }
    );
  }

  async function readUsers(account) {
    return requestResource(
      { type: "user", id: account ?? config.fizzy?.account ?? "default" },
      { path: accountPath("/users", account) }
    );
  }

  async function listUsers(account) {
    return (await readUsers(account)).data;
  }

  async function getUser(userId, options = {}) {
    return requestData(
      { type: "user", id: userId },
      { path: accountPath(`/users/${encodePathPart(userId)}`, options.account) }
    );
  }

  async function readWebhooks(input = {}) {
    const boardId = input.board_id ?? input.boardId ?? input;
    return requestResource(
      { type: "webhook", id: boardId },
      { path: accountPath(`/boards/${encodePathPart(boardId)}/webhooks`, input.account) }
    );
  }

  async function listWebhooks(input = {}) {
    return (await readWebhooks(input)).data;
  }

  async function getWebhook(input = {}) {
    const boardId = input.board_id ?? input.boardId;
    const webhookId = input.webhook_id ?? input.webhookId ?? input.id;
    return requestData(
      { type: "webhook", id: webhookId },
      {
        path: accountPath(
          `/boards/${encodePathPart(boardId)}/webhooks/${encodePathPart(webhookId)}`,
          input.account
        )
      }
    );
  }

  async function createWebhook(input = {}) {
    const boardId = input.board_id ?? input.boardId;
    return writeResource(
      { type: "webhook_create", id: boardId },
      {
        method: "POST",
        path: accountPath(`/boards/${encodePathPart(boardId)}/webhooks`, input.account),
        body: {
          webhook: {
            name: input.name ?? "fizzy-symphony",
            url: input.callback_url ?? input.url,
            subscribed_actions: normalizeActions(input.subscribed_actions)
          }
        }
      }
    );
  }

  async function updateWebhook(input = {}) {
    const boardId = input.board_id ?? input.boardId;
    const webhookId = input.webhook_id ?? input.webhookId ?? input.id;
    return writeResource(
      { type: "webhook_update", id: webhookId },
      {
        method: "PATCH",
        path: accountPath(
          `/boards/${encodePathPart(boardId)}/webhooks/${encodePathPart(webhookId)}`,
          input.account
        ),
        body: {
          webhook: omitUndefined({
            name: input.name,
            subscribed_actions: input.subscribed_actions ? normalizeActions(input.subscribed_actions) : undefined
          })
        }
      }
    );
  }

  async function reactivateWebhook(input = {}) {
    const boardId = input.board_id ?? input.boardId;
    const webhookId = input.webhook_id ?? input.webhookId ?? input.id;
    return writeResource(
      { type: "webhook_activation", id: webhookId },
      {
        method: "POST",
        path: accountPath(
          `/boards/${encodePathPart(boardId)}/webhooks/${encodePathPart(webhookId)}/activation`,
          input.account
        )
      }
    );
  }

  async function listWebhookDeliveries(input = {}) {
    const boardId = input.board_id ?? input.boardId;
    const webhookId = input.webhook_id ?? input.webhookId ?? input.id;
    return requestData(
      { type: "webhook_delivery", id: webhookId },
      {
        path: accountPath(
          `/boards/${encodePathPart(boardId)}/webhooks/${encodePathPart(webhookId)}/deliveries`,
          input.account
        )
      }
    );
  }

  async function ensureWebhook(input = {}) {
    const boardId = input.board_id ?? input.boardId;
    const callbackUrl = input.callback_url ?? input.url;
    const desired = {
      name: input.name ?? "fizzy-symphony",
      subscribed_actions: normalizeActions(input.subscribed_actions)
    };
    const existing = (await listWebhooks({ board_id: boardId, account: input.account }))
      .find((webhook) => webhookUrl(webhook) === callbackUrl);

    if (!existing) {
      return createWebhook({
        ...desired,
        board_id: boardId,
        account: input.account,
        callback_url: callbackUrl
      });
    }

    let current = existing;
    if (webhookNeedsUpdate(existing, desired)) {
      current = await updateWebhook({
        ...desired,
        board_id: boardId,
        account: input.account,
        webhook_id: existing.id
      });
    }

    if (current?.active === false || current?.status === "inactive") {
      current = await reactivateWebhook({
        board_id: boardId,
        account: input.account,
        webhook_id: current.id ?? existing.id
      });
    }

    return current;
  }

  async function readIdentity() {
    return requestResource(
      { type: "identity", id: "current" },
      { path: "/my/identity" }
    );
  }

  async function getIdentity() {
    return (await readIdentity()).data;
  }

  async function getAccountSettings() {
    return requestData(
      { type: "account", id: "settings" },
      { path: "/account/settings" }
    );
  }

  async function getEntropy(_account, boardIds = []) {
    const warnings = [];
    try {
      const account = await getAccountSettings();
      if (Number(account?.auto_postpone_period_in_days) > 0) {
        warnings.push({
          code: "ENTROPY_AUTO_POSTPONE",
          message: "Account auto-postpone is enabled.",
          auto_postpone_period_in_days: account.auto_postpone_period_in_days
        });
      }
    } catch (error) {
      warnings.push({
        code: "ENTROPY_ACCOUNT_UNKNOWN",
        message: "Fizzy account entropy settings were not visible.",
        cause: error.message
      });
    }

    for (const boardId of boardIds ?? []) {
      try {
        const board = await requestData(
          { type: "board", id: boardId },
          { path: accountPath(`/boards/${encodePathPart(boardId)}`) }
        );
        if (Number(board?.auto_postpone_period_in_days) > 0) {
          warnings.push({
            code: "ENTROPY_AUTO_POSTPONE",
            message: "Board auto-postpone is enabled.",
            board_id: boardId,
            auto_postpone_period_in_days: board.auto_postpone_period_in_days
          });
        }
      } catch (error) {
        warnings.push({
          code: "ENTROPY_BOARD_UNKNOWN",
          message: "Fizzy board entropy settings were not visible.",
          board_id: boardId,
          cause: error.message
        });
      }
    }

    return { warnings };
  }

  async function createBoard(input = {}) {
    return writeResource(
      { type: "board_create", id: input.name },
      {
        method: "POST",
        path: accountPath("/boards", input.account),
        body: { board: omitKeys(input, ["account"]) }
      }
    );
  }

  async function createColumn(boardOrInput, maybeInput = {}) {
    const input = typeof boardOrInput === "object"
      ? boardOrInput
      : { ...maybeInput, board_id: boardOrInput };
    const boardId = input.board_id ?? input.boardId;
    return writeResource(
      { type: "column_create", id: boardId },
      {
        method: "POST",
        path: accountPath(`/boards/${encodePathPart(boardId)}/columns`, input.account),
        body: { column: omitKeys(input, ["account", "board_id", "boardId"]) }
      }
    );
  }

  async function createCard(input = {}) {
    const boardId = input.board_id ?? input.boardId;
    return writeResource(
      { type: "card_create", id: boardId },
      {
        method: "POST",
        path: accountPath(`/boards/${encodePathPart(boardId)}/cards`, input.account),
        body: { card: omitKeys(input, ["account", "board_id", "boardId"]) }
      }
    );
  }

  async function closeCard(input = {}) {
    const cardNumber = cardNumberFrom(input);
    return writeResource(
      { type: "card_closure", id: cardNumber },
      {
        method: "POST",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/closure`, input.account)
      }
    );
  }

  async function reopenCard(input = {}) {
    const cardNumber = cardNumberFrom(input);
    return writeResource(
      { type: "card_reopen", id: cardNumber },
      {
        method: "DELETE",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/closure`, input.account)
      }
    );
  }

  async function moveCardToColumn(input = {}) {
    const cardNumber = cardNumberFrom(input);
    const columnId = input.column_id ?? input.columnId ?? input.target_column_id;
    return writeResource(
      { type: "card_triage", id: cardNumber },
      {
        method: "POST",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/triage`, input.account),
        body: { column_id: columnId }
      }
    );
  }

  async function sendCardToTriage(input = {}) {
    const cardNumber = cardNumberFrom(input);
    return writeResource(
      { type: "card_untriage", id: cardNumber },
      {
        method: "DELETE",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/triage`, input.account)
      }
    );
  }

  async function toggleTag(input = {}) {
    const cardNumber = cardNumberFrom(input);
    const tagTitle = input.tag_title ?? input.tagTitle ?? input.tag;
    return writeResource(
      { type: "card_tagging", id: cardNumber },
      {
        method: "POST",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/taggings`, input.account),
        body: { tag_title: normalizeTagTitle(tagTitle) }
      }
    );
  }

  async function markCardGolden(input = {}) {
    const cardNumber = cardNumberFrom(input);
    return writeResource(
      { type: "card_goldness", id: cardNumber },
      {
        method: "POST",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/goldness`, input.account)
      }
    );
  }

  async function unmarkCardGolden(input = {}) {
    const cardNumber = cardNumberFrom(input);
    return writeResource(
      { type: "card_goldness_remove", id: cardNumber },
      {
        method: "DELETE",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/goldness`, input.account)
      }
    );
  }

  async function assignCard(input = {}) {
    const cardNumber = cardNumberFrom(input);
    const assigneeId = input.assignee_id ?? input.assigneeId ?? input.user_id ?? input.userId;
    return writeResource(
      { type: "card_assignment", id: cardNumber },
      {
        method: "POST",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/assignments`, input.account),
        body: { assignee_id: assigneeId }
      }
    );
  }

  async function watchCard(input = {}) {
    const cardNumber = cardNumberFrom(input);
    return writeResource(
      { type: "card_watch", id: cardNumber },
      {
        method: "POST",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/watch`, input.account)
      }
    );
  }

  async function unwatchCard(input = {}) {
    const cardNumber = cardNumberFrom(input);
    return writeResource(
      { type: "card_unwatch", id: cardNumber },
      {
        method: "DELETE",
        path: accountPath(`/cards/${encodePathPart(cardNumber)}/watch`, input.account)
      }
    );
  }

  async function postResultComment(input = {}) {
    return createComment({
      ...input,
      body: input.body ?? resultCommentBody(input)
    });
  }

  async function recordCompletionMarker(input = {}) {
    const comment = await createComment(input);
    if (input.tag) await toggleTag({ ...input, tag: input.tag });
    return { ...(comment ?? {}), tag: input.tag, body: input.body, payload: input.payload };
  }

  async function recordCompletionFailureMarker(input = {}) {
    return recordCompletionMarker(input);
  }

  return {
    readIdentity,
    getIdentity,
    readBoards,
    listBoards: async (account) => (await readBoards(account)).data,
    readBoard,
    getBoard,
    readColumns,
    listColumns,
    readColumn,
    readCards,
    listCards,
    discoverCandidates,
    readGoldenCards,
    listGoldenCards,
    readCard,
    getCard,
    refreshCard,
    refreshActiveCards,
    readComments,
    listComments,
    getComment,
    createComment,
    postComment: createComment,
    createCardComment: createComment,
    postStructuredComment: createComment,
    postWorkpadComment: createComment,
    postResultComment,
    updateComment,
    updateWorkpadComment: updateComment,
    deleteComment,
    getStep,
    listSteps,
    createStep,
    updateStep,
    deleteStep,
    readTags,
    listTags,
    getTag,
    readUsers,
    listUsers,
    getUser,
    readWebhooks,
    listWebhooks,
    getWebhook,
    createWebhook,
    updateWebhook,
    reactivateWebhook,
    listWebhookDeliveries,
    ensureWebhook,
    getAccountSettings,
    getEntropy,
    createBoard,
    createColumn,
    createCard,
    closeCard,
    close: closeCard,
    reopenCard,
    moveCardToColumn,
    moveCard: moveCardToColumn,
    triageCard: moveCardToColumn,
    sendCardToTriage,
    toggleTag,
    removeTag: toggleTag,
    markCardGolden,
    markGoldenCard: markCardGolden,
    markGolden: markCardGolden,
    unmarkCardGolden,
    unmarkGoldenCard: unmarkCardGolden,
    recordCompletionMarker,
    recordCompletionFailureMarker,
    assignCard,
    assignToCard: assignCard,
    addAssignee: assignCard,
    watchCard,
    addWatcher: watchCard,
    unwatchCard,
    etagStats() {
      return etagCache?.stats?.() ?? { hits: 0, misses: 0, invalid: 0 };
    }
  };
}

export function createFetchTransport({ config = {}, fetch = globalThis.fetch } = {}) {
  if (typeof fetch !== "function") {
    throw new TypeError("createFizzyClient requires a fetch implementation when no transport is supplied.");
  }

  const baseUrl = String(config.fizzy?.api_url ?? "").replace(/\/+$/u, "");
  const token = config.fizzy?.token ?? "";

  return async function fetchTransport(request = {}) {
    const method = request.method ?? "GET";
    const url = buildUrl(baseUrl, request.path, request.query);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(request.headers ?? {})
    };
    const init = { method, headers };

    if (request.body !== undefined) {
      init.body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    }

    const response = await fetch(url, init);
    return readFetchResponse(response, {
      fetch,
      headers,
      path: request.path,
      method
    });
  };
}

export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const received = normalizeSignature(signature);
  if (!received || !/^[a-f0-9]{64}$/iu.test(received)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");
  if (expectedBuffer.length !== receivedBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function verifyWebhookRequest({
  rawBody,
  body,
  headers = {},
  secret,
  now = new Date(),
  toleranceSeconds = 300
} = {}) {
  if (!secret) {
    return { ok: true, verified: false, reason: "no_secret_configured" };
  }

  const signature = headerValue(headers, "x-webhook-signature");
  if (!verifyWebhookSignature(rawBody ?? body ?? "", signature, secret)) {
    return {
      ok: false,
      code: "INVALID_WEBHOOK_SIGNATURE",
      status: 401,
      verified: false
    };
  }

  const timestamp = headerValue(headers, "x-webhook-timestamp");
  if (!isWebhookFresh(timestamp, { now, toleranceSeconds })) {
    return {
      ok: false,
      code: "STALE_WEBHOOK_EVENT",
      status: 400,
      verified: true
    };
  }

  return { ok: true, verified: true };
}

async function readFetchResponse(response, options = {}) {
  const headers = headersObject(response.headers);
  const body = await parseFetchBody(response, headers);
  let finalBody = body;

  if (
    response.status >= 200 &&
    response.status < 300 &&
    response.status !== 204 &&
    Array.isArray(body) &&
    options.method === "GET"
  ) {
    let nextUrl = parseNextLink(headers.link);
    while (nextUrl) {
      const nextResponse = await options.fetch(nextUrl, {
        method: "GET",
        headers: options.headers
      });
      const nextHeaders = headersObject(nextResponse.headers);
      if (!nextResponse.ok) {
        const nextBody = await parseFetchBody(nextResponse, nextHeaders);
        return {
          status: nextResponse.status,
          statusText: nextResponse.statusText,
          headers: nextHeaders,
          body: nextBody
        };
      }
      const nextBody = await parseFetchBody(nextResponse, nextHeaders);
      if (Array.isArray(nextBody)) finalBody = finalBody.concat(nextBody);
      nextUrl = parseNextLink(nextHeaders.link);
    }
  }

  return {
    status: response.status,
    statusCode: response.status,
    statusText: response.statusText,
    headers,
    body: finalBody,
    metadata: responseMetadata({ headers, path: options.path, method: options.method })
  };
}

async function parseFetchBody(response, headers) {
  if (response.status === 204 || response.status === 304) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = headers["content-type"] ?? "";
  if (contentType.includes("json") || /^[\s\n\r]*[\[{]/u.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function apiError({ response, request }) {
  const status = Number(response?.status ?? response?.statusCode);
  const metadata = responseMetadata({
    headers: response?.headers,
    path: request.path,
    method: request.method,
    status,
    body: response?.body ?? response?.data
  });
  return new FizzyApiError(`Fizzy API request failed with status ${status}.`, metadata);
}

function responseMetadata({ headers = {}, path, method, status, body } = {}) {
  return omitUndefined({
    status,
    method,
    path,
    request_id: headerValue(headers, "x-request-id") ?? headerValue(headers, "request-id"),
    location: headerValue(headers, "location"),
    retry_after: headerValue(headers, "retry-after"),
    rate_limit: compactObject({
      limit: headerValue(headers, "x-ratelimit-limit"),
      remaining: headerValue(headers, "x-ratelimit-remaining"),
      reset: headerValue(headers, "x-ratelimit-reset")
    }),
    body_summary: safeBodySummary(body)
  });
}

function safeBodySummary(body) {
  if (body === null || body === undefined || body === "") return undefined;
  if (typeof body === "string") return truncate(body);
  if (Array.isArray(body)) return { items: body.length };
  if (typeof body !== "object") return String(body);

  const picked = {};
  for (const key of ["error", "message", "code", "errors"]) {
    if (Object.hasOwn(body, key)) picked[key] = sanitizeBodyValue(body[key]);
  }
  if (Object.keys(picked).length > 0) return picked;
  return { keys: Object.keys(body).filter((key) => !REDACTED_BODY_KEYS.has(key.toLowerCase())).slice(0, 8) };
}

function sanitizeBodyValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncate(value);
  if (Array.isArray(value)) return value.slice(0, 5).map(sanitizeBodyValue);
  if (typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !REDACTED_BODY_KEYS.has(key.toLowerCase()))
      .slice(0, 8)
      .map(([key, entry]) => [key, sanitizeBodyValue(entry)])
  );
}

function truncate(value, max = 240) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function responseDataWithLocation(result) {
  if (result.data) return result.data;
  const location = headerValue(result.metadata, "location") ?? headerValue(result, "location");
  const id = location ? String(location).replace(/\.json$/u, "").split("/").filter(Boolean).at(-1) : undefined;
  return omitUndefined({ id, url: location });
}

function responseEtag(response) {
  const headers = response?.headers ?? {};
  return response?.etag ?? headerValue(headers, "etag");
}

function headersObject(headers = {}) {
  if (typeof headers.entries === "function") {
    return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function headerValue(headers = {}, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? headers.get(name.toLowerCase());
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
}

function buildUrl(baseUrl, path, query = {}) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== undefined && entry !== null && entry !== "") {
          url.searchParams.append(arrayQueryKey(key), String(entry));
        }
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function arrayQueryKey(key) {
  return key.endsWith("[]") ? key : `${key}[]`;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of String(linkHeader).split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="?next"?/iu);
    if (match) return match[1];
  }
  return null;
}

export function cardNumberFrom(input) {
  if (typeof input === "number") return input;
  if (typeof input === "string" && /^\d+$/u.test(input)) return input;
  const card = input?.card ?? input;
  const value = card?.number ?? card?.card_number ?? input?.card_number ?? input?.cardNumber;
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/u.test(value))) return value;
  throw new FizzySymphonyError(
    "FIZZY_CARD_NUMBER_REQUIRED",
    "Fizzy card routes require the card number; UUID-only card IDs cannot address card resources.",
    { card_id: card?.id ?? input?.card_id ?? input?.cardId ?? (typeof input === "string" ? input : undefined) }
  );
}

export function normalizeActions(actions = DEFAULT_WEBHOOK_ACTIONS) {
  return [...new Set(actions ?? DEFAULT_WEBHOOK_ACTIONS)].sort();
}

export function webhookUrl(webhook = {}) {
  return webhook.payload_url ?? webhook.url ?? webhook.callback_url;
}

export function webhookNeedsUpdate(webhook, desired) {
  return webhook.name !== desired.name || !sameSet(webhook.subscribed_actions ?? [], desired.subscribed_actions);
}

function sameSet(left = [], right = []) {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((entry, index) => entry === normalizedRight[index]);
}

function normalizeSignature(signature) {
  const value = String(signature ?? "").trim();
  return value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
}

function isWebhookFresh(timestamp, { now = new Date(), toleranceSeconds = 300 } = {}) {
  const eventTime = new Date(timestamp).getTime();
  if (!Number.isFinite(eventTime)) return false;
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowTime)) return false;
  return Math.abs(nowTime - eventTime) <= toleranceSeconds * 1000;
}

export function resultCommentBody({ result = {}, proof } = {}) {
  const body = result.output_html ?? result.body ?? result.output ?? result.output_summary ?? result.summary;
  if (body) return richCommentHtml(body);
  if (proof?.file) return `<p>Agent run completed. Proof: <code>${escapeHtml(proof.file)}</code></p>`;
  return "<p>Agent run completed.</p>";
}

function richCommentHtml(value) {
  const body = String(value).trim();
  if (!body) return "<p>Agent run completed.</p>";
  if (looksLikeHtml(body)) return body;

  return body
    .split(/\n{2,}/u)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/gu, "<br>")}</p>`)
    .join("\n");
}

function looksLikeHtml(value) {
  return /<(?:p|br|strong|em|ul|ol|li|h[1-6]|pre|code|blockquote|a|div|span)\b[^>]*>/iu.test(value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function encodePathPart(value) {
  return encodeURIComponent(String(value ?? ""));
}

export function accountPathSegment(account) {
  const raw = typeof account === "object" && account !== null
    ? account.slug ?? account.path ?? account.id ?? account.name
    : account;
  return String(raw ?? "").trim().replace(/^\/+|\/+$/gu, "");
}

export function normalizeTagTitle(value) {
  return String(value ?? "").trim().replace(/^#+/u, "");
}

export function omitKeys(value = {}, keys = []) {
  const skipped = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !skipped.has(key)));
}

export function omitUndefined(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function compactObject(value = {}) {
  const compacted = omitUndefined(value);
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}
