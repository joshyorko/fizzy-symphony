import { createFizzyClient as createOfficialFizzyClient } from "@37signals/fizzy";

import {
  FizzyApiError,
  accountPathSegment,
  cardNumberFrom,
  createLegacyFizzyClient,
  normalizeActions,
  normalizeTagTitle,
  omitKeys,
  omitUndefined,
  webhookNeedsUpdate,
  webhookUrl
} from "./fizzy-http-client.js";

export function createSdkBackedFizzyClient(options = {}) {
  const { config = {} } = options;
  const legacy = createLegacyFizzyClient(options);
  const sdkFactory = options.sdkFactory ?? ((sdkOptions) => createOfficialFizzyClient(sdkOptions));
  const rootBaseUrl = normalizeBaseUrl(config.fizzy?.api_url);
  const rootClientValue = options.sdkRootClient;
  let cachedRootClient = null;
  const accountClients = new Map();

  function createSdkClient({ baseUrl }) {
    return sdkFactory({
      accessToken: config.fizzy?.token ?? "",
      baseUrl
    });
  }

  function rootClient() {
    if (rootClientValue) return rootClientValue;
    cachedRootClient ??= createSdkClient({ baseUrl: rootBaseUrl });
    return cachedRootClient;
  }

  function accountClient(account = config.fizzy?.account) {
    const segment = accountPathSegment(account);
    if (!segment) {
      throw new FizzySymphonyError("FIZZY_ACCOUNT_REQUIRED", "Fizzy account slug is required for this API route.");
    }

    if (!accountClients.has(segment)) {
      accountClients.set(segment, createSdkClient({ baseUrl: `${rootBaseUrl}/${encodeURIComponent(segment)}` }));
    }
    return accountClients.get(segment);
  }

  async function callSdk(action) {
    try {
      return await action();
    } catch (error) {
      throw normalizeSdkError(error);
    }
  }

  async function getIdentity() {
    return callSdk(() => rootClient().identity.me());
  }

  async function listBoards(account) {
    return plainList(await callSdk(() => accountClient(account).boards.list()));
  }

  async function getBoard(boardId, input = {}) {
    const client = accountClient(input.account);
    const board = await callSdk(() => client.boards.get(boardId));
    const hydrated = { ...(board ?? {}) };

    if (input.includeColumns !== false && !Array.isArray(hydrated.columns)) {
      hydrated.columns = plainList(await callSdk(() => client.columns.list(boardId)));
    }

    if (input.includeCards !== false && !Array.isArray(hydrated.cards)) {
      hydrated.cards = plainList(await callSdk(() => client.cards.list({ boardIds: [boardId] })));
    }

    return hydrated;
  }

  async function listColumns(boardId, input = {}) {
    return plainList(await callSdk(() => accountClient(input.account).columns.list(boardId)));
  }

  async function readColumn(input = {}) {
    return legacy.readColumn(input);
  }

  async function listCards(input = {}) {
    const query = input.query ?? omitKeys(input, ["account"]);
    return plainList(await callSdk(() => accountClient(input.account).cards.list(cardListOptionsFromQuery(query))));
  }

  async function listGoldenCards(input = {}) {
    const query = { ...(input.query ?? omitKeys(input, ["account"])), indexed_by: "golden" };
    return listCards({ ...input, query });
  }

  async function getCard(card) {
    return callSdk(() => accountClient(card?.account).cards.get(cardNumberFrom(card)));
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

  async function listComments(input = {}) {
    return plainList(await callSdk(() => accountClient(input.account).comments.list(cardNumberFrom(input))));
  }

  async function getComment(input = {}) {
    return callSdk(() => accountClient(input.account).comments.get(
      cardNumberFrom(input),
      input.comment_id ?? input.commentId ?? input.id
    ));
  }

  async function createComment(input = {}) {
    return callSdk(() => accountClient(input.account).comments.create(cardNumberFrom(input), {
      body: input.body ?? ""
    }));
  }

  async function updateComment(input = {}) {
    return callSdk(() => accountClient(input.account).comments.update(
      cardNumberFrom(input),
      input.comment_id ?? input.commentId ?? input.id,
      { body: input.body ?? "" }
    ));
  }

  async function deleteComment(input = {}) {
    return callSdk(() => accountClient(input.account).comments.delete(
      cardNumberFrom(input),
      input.comment_id ?? input.commentId ?? input.id
    ));
  }

  async function createStep(input = {}) {
    return callSdk(() => accountClient(input.account).steps.create(cardNumberFrom(input), omitUndefined({
      content: input.content,
      completed: input.completed
    })));
  }

  async function getStep(input = {}) {
    return callSdk(() => accountClient(input.account).steps.get(
      cardNumberFrom(input),
      input.step_id ?? input.stepId ?? input.id
    ));
  }

  async function listSteps(input = {}) {
    return plainList(await callSdk(() => accountClient(input.account).steps.list(cardNumberFrom(input))));
  }

  async function updateStep(input = {}) {
    return callSdk(() => accountClient(input.account).steps.update(
      cardNumberFrom(input),
      input.step_id ?? input.stepId ?? input.id,
      omitUndefined({ content: input.content, completed: input.completed })
    ));
  }

  async function deleteStep(input = {}) {
    return callSdk(() => accountClient(input.account).steps.delete(
      cardNumberFrom(input),
      input.step_id ?? input.stepId ?? input.id
    ));
  }

  async function listTags(account) {
    return plainList(await callSdk(() => accountClient(account).tags.list()));
  }

  async function getTag(tagId, input = {}) {
    return legacy.getTag(tagId, input);
  }

  async function listUsers(account) {
    return plainList(await callSdk(() => accountClient(account).users.list()));
  }

  async function getUser(userId, input = {}) {
    return callSdk(() => accountClient(input.account).users.get(userId));
  }

  async function listWebhooks(input = {}) {
    return plainList(await callSdk(() => accountClient(input.account).webhooks.list(input.board_id ?? input.boardId ?? input)));
  }

  async function getWebhook(input = {}) {
    return callSdk(() => accountClient(input.account).webhooks.get(
      input.board_id ?? input.boardId,
      input.webhook_id ?? input.webhookId ?? input.id
    ));
  }

  async function createWebhook(input = {}) {
    return callSdk(() => accountClient(input.account).webhooks.create(input.board_id ?? input.boardId, {
      name: input.name ?? "fizzy-symphony",
      url: input.callback_url ?? input.url,
      subscribedActions: normalizeActions(input.subscribed_actions)
    }));
  }

  async function updateWebhook(input = {}) {
    return callSdk(() => accountClient(input.account).webhooks.update(
      input.board_id ?? input.boardId,
      input.webhook_id ?? input.webhookId ?? input.id,
      omitUndefined({
        name: input.name,
        subscribedActions: input.subscribed_actions ? normalizeActions(input.subscribed_actions) : undefined
      })
    ));
  }

  async function reactivateWebhook(input = {}) {
    const boardId = input.board_id ?? input.boardId;
    const webhookId = input.webhook_id ?? input.webhookId ?? input.id;
    await callSdk(() => accountClient(input.account).webhooks.activate(boardId, webhookId));
    return getWebhook({ ...input, board_id: boardId, webhook_id: webhookId });
  }

  async function listWebhookDeliveries(input = {}) {
    return plainList(await callSdk(() => accountClient(input.account).webhooks.listWebhookDeliveries(
      input.board_id ?? input.boardId,
      input.webhook_id ?? input.webhookId ?? input.id
    )));
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

  async function getAccountSettings() {
    return callSdk(() => rootClient().miscellaneous.accountSettings());
  }

  async function getEntropy(account, boardIds = []) {
    const warnings = [];
    try {
      const settings = await getAccountSettings();
      if (Number(settings?.auto_postpone_period_in_days) > 0) {
        warnings.push({
          code: "ENTROPY_AUTO_POSTPONE",
          message: "Account auto-postpone is enabled.",
          auto_postpone_period_in_days: settings.auto_postpone_period_in_days
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
        const board = await getBoard(boardId, { account, includeColumns: false, includeCards: false });
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
    return callSdk(() => accountClient(input.account).boards.create(omitUndefined({
      name: input.name,
      allAccess: input.all_access ?? input.allAccess,
      autoPostponePeriodInDays: input.auto_postpone_period_in_days ?? input.autoPostponePeriodInDays,
      publicDescription: input.public_description ?? input.publicDescription
    })));
  }

  async function createColumn(boardOrInput, maybeInput = {}) {
    const input = typeof boardOrInput === "object" ? boardOrInput : { ...maybeInput, board_id: boardOrInput };
    return callSdk(() => accountClient(input.account).columns.create(
      input.board_id ?? input.boardId,
      omitUndefined({ name: input.name, color: input.color })
    ));
  }

  async function createCard(input = {}) {
    return callSdk(() => accountClient(input.account).cards.create(omitUndefined({
      title: input.title,
      boardId: input.board_id ?? input.boardId,
      columnId: input.column_id ?? input.columnId,
      description: input.description,
      assigneeIds: input.assignee_ids ?? input.assigneeIds,
      tagNames: input.tags ?? input.tag_names ?? input.tagNames,
      image: input.image,
      createdAt: input.created_at ?? input.createdAt,
      lastActiveAt: input.last_active_at ?? input.lastActiveAt
    })));
  }

  async function closeCard(input = {}) {
    return callSdk(() => accountClient(input.account).cards.close(cardNumberFrom(input)));
  }

  async function reopenCard(input = {}) {
    return callSdk(() => accountClient(input.account).cards.reopen(cardNumberFrom(input)));
  }

  async function moveCardToColumn(input = {}) {
    return callSdk(() => accountClient(input.account).cards.triage(cardNumberFrom(input), {
      columnId: input.column_id ?? input.columnId ?? input.target_column_id
    }));
  }

  async function sendCardToTriage(input = {}) {
    return callSdk(() => accountClient(input.account).cards.untriage(cardNumberFrom(input)));
  }

  async function toggleTag(input = {}) {
    return callSdk(() => accountClient(input.account).cards.tag(cardNumberFrom(input), {
      tagTitle: normalizeTagTitle(input.tag_title ?? input.tagTitle ?? input.tag)
    }));
  }

  async function markCardGolden(input = {}) {
    return callSdk(() => accountClient(input.account).cards.gold(cardNumberFrom(input)));
  }

  async function unmarkCardGolden(input = {}) {
    return callSdk(() => accountClient(input.account).cards.ungold(cardNumberFrom(input)));
  }

  async function assignCard(input = {}) {
    return callSdk(() => accountClient(input.account).cards.assign(cardNumberFrom(input), {
      assigneeId: input.assignee_id ?? input.assigneeId ?? input.user_id ?? input.userId
    }));
  }

  async function watchCard(input = {}) {
    return callSdk(() => accountClient(input.account).cards.watch(cardNumberFrom(input)));
  }

  async function unwatchCard(input = {}) {
    return callSdk(() => accountClient(input.account).cards.unwatch(cardNumberFrom(input)));
  }

  return {
    ...legacy,
    getIdentity,
    listBoards,
    getBoard,
    listColumns,
    readColumn,
    listCards,
    listGoldenCards,
    getCard,
    refreshCard,
    refreshActiveCards,
    listComments,
    getComment,
    createComment,
    postComment: createComment,
    createCardComment: createComment,
    postStructuredComment: createComment,
    postWorkpadComment: createComment,
    updateComment,
    updateWorkpadComment: updateComment,
    deleteComment,
    getStep,
    listSteps,
    createStep,
    updateStep,
    deleteStep,
    listTags,
    getTag,
    listUsers,
    getUser,
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
    assignCard,
    assignToCard: assignCard,
    addAssignee: assignCard,
    watchCard,
    addWatcher: watchCard,
    unwatchCard
  };
}

function normalizeSdkError(error) {
  if (error instanceof FizzyApiError || error instanceof FizzySymphonyError) {
    return error;
  }

  return new FizzyApiError(error?.message ?? "Fizzy SDK request failed.", omitUndefined({
    status: Number(error?.httpStatus ?? error?.status) || undefined,
    code: error?.code,
    hint: error?.hint,
    retryable: error?.retryable,
    request_id: error?.requestId
  }));
}

function normalizeBaseUrl(value) {
  return String(value ?? "").replace(/\/+$/u, "");
}

function plainList(value) {
  return Array.isArray(value) ? [...value] : value;
}

function cardListOptionsFromQuery(query = {}) {
  return omitUndefined({
    boardIds: query.board_ids ?? query.boardIds,
    tagIds: query.tag_ids ?? query.tagIds,
    assigneeIds: query.assignee_ids ?? query.assigneeIds,
    creatorIds: query.creator_ids ?? query.creatorIds,
    closerIds: query.closer_ids ?? query.closerIds,
    cardIds: query.card_ids ?? query.cardIds,
    columnIds: query.column_ids ?? query.columnIds,
    indexedBy: query.indexed_by ?? query.indexedBy,
    sortedBy: query.sorted_by ?? query.sortedBy,
    assignmentStatus: query.assignment_status ?? query.assignmentStatus,
    creation: query.creation,
    closure: query.closure,
    terms: query.terms,
    maxItems: query.max_items ?? query.maxItems
  });
}
