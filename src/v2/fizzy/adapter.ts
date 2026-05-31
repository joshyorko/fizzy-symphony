// SDK / HTTP boundary for the FizzyPort.
//
// The daemon and cockpit depend on FizzyPort (in core/types.ts), never on the
// Fizzy SDK types. This adapter delegates to the existing v1 SDK/HTTP client,
// translating its snake_case API into the v2 port vocabulary.

import { createFizzyClient } from "../../fizzy-client.js";
import { cardBoardId, cardColumnId, commentBody } from "../../fizzy-normalize.js";
import type { FizzyPort } from "../core/types.ts";

export type FizzyAdapterMode = "sdk" | "http";

export interface FizzyAdapterOptions {
  mode?: FizzyAdapterMode;
  client?: Record<string, any>;
  clientFactory?: (options?: Record<string, unknown>) => Record<string, any>;
  config?: Record<string, any>;
  apiUrl?: string;
  token?: string;
  account?: string;
  fetch?: typeof fetch;
  transport?: (...args: any[]) => any;
  sdkFactory?: (...args: any[]) => any;
  sdkRootClient?: Record<string, any>;
}

function notWired(operation: string, mode: FizzyAdapterMode): never {
  const error = new Error(
    `FizzyPort.${operation} is not wired in the v2 spike (${mode} mode). ` +
      `Delegate to v1 src/fizzy-client.js or implement the ${mode} call here.`
  );
  (error as { code?: string }).code = "FIZZY_ADAPTER_NOT_WIRED";
  throw error;
}

// Returns a FizzyPort that delegates to the existing v1 client and normalizes
// live client shapes into the v2 cockpit vocabulary.
export function createFizzyAdapter(options: FizzyAdapterOptions = {}): FizzyPort {
  const mode: FizzyAdapterMode = options.mode ?? "sdk";
  let cachedClient: Record<string, any> | null = null;
  const note =
    mode === "sdk"
      ? "delegates to @37signals/fizzy via the v1 SDK-backed client"
      : "delegates to the v1 direct HTTP client";

  function client() {
    if (options.client) return options.client;
    if (cachedClient) return cachedClient;
    const config = {
      ...(options.config ?? {}),
      fizzy: {
        ...(options.config?.fizzy ?? {}),
        token: options.token ?? options.config?.fizzy?.token ?? "",
        api_url: options.apiUrl ?? options.config?.fizzy?.api_url ?? "",
        account: options.account ?? options.config?.fizzy?.account
      }
    };
    const factory = options.clientFactory ?? createFizzyClient;
    cachedClient = factory({
      config,
      fetch: options.fetch,
      transport: options.transport,
      sdkFactory: options.sdkFactory,
      sdkRootClient: options.sdkRootClient
    });
    return cachedClient;
  }

  function account() {
    return options.account ?? options.config?.fizzy?.account;
  }

  return {
    describe() {
      return { kind: `fizzy-${mode}`, sdk: mode === "sdk", note };
    },
    async listBoards() {
      const fn = client().listBoards;
      if (typeof fn !== "function") return notWired("listBoards", mode);
      return (await fn.call(client(), account())).map(normalizeBoard);
    },
    async getBoard(input) {
      const fn = client().getBoard;
      if (typeof fn !== "function") return notWired("getBoard", mode);
      return normalizeBoard(await fn.call(client(), input.boardId, { account: account() }));
    },
    async listCards(input) {
      const fn = client().listCards;
      if (typeof fn !== "function") return notWired("listCards", mode);
      const cards = await fn.call(client(), {
        account: account(),
        query: {
          board_ids: [input.boardId],
          column_ids: input.columnId ? [input.columnId] : undefined
        }
      });
      return cards.map(normalizeCard);
    },
    async getCard(input) {
      const fn = client().getCard;
      if (typeof fn !== "function") return notWired("getCard", mode);
      return normalizeCard(await fn.call(client(), {
        account: account(),
        cardNumber: input.cardId
      }));
    },
    async listComments(input) {
      const fn = client().listComments;
      if (typeof fn !== "function") return notWired("listComments", mode);
      return (await fn.call(client(), {
        account: account(),
        cardNumber: input.cardId
      })).map((comment: Record<string, any>) => normalizeComment(comment, input.cardId));
    },
    async createComment(input) {
      const fn = client().createComment;
      if (typeof fn !== "function") return notWired("createComment", mode);
      return normalizeComment(await fn.call(client(), {
        account: account(),
        cardNumber: input.cardNumber ?? input.cardId,
        body: input.body
      }), input.cardId);
    },
    async updateComment(input) {
      const fn = client().updateComment;
      if (typeof fn !== "function") return notWired("updateComment", mode);
      return normalizeComment(await fn.call(client(), {
        account: account(),
        cardNumber: input.cardNumber ?? input.cardId,
        commentId: input.commentId,
        body: input.body
      }), input.cardId ?? "");
    },
    async moveCard(input) {
      const fn = client().moveCardToColumn ?? client().moveCard;
      if (typeof fn !== "function") return notWired("moveCard", mode);
      return normalizeCard(await fn.call(client(), {
        account: account(),
        card: { id: input.cardId, number: input.cardNumber },
        cardNumber: input.cardNumber ?? input.cardId,
        column_id: input.targetColumnId,
        target_column_id: input.targetColumnId
      }));
    },
    async listWebhooks(input) {
      const fn = client().listWebhooks;
      if (typeof fn !== "function") return notWired("listWebhooks", mode);
      return (await fn.call(client(), {
        account: account(),
        board_id: input.boardId
      })).map(normalizeWebhook);
    }
  };
}

function normalizeBoard(board: Record<string, any> = {}) {
  return {
    id: String(board.id ?? board.board_id ?? ""),
    name: String(board.name ?? board.label ?? board.title ?? board.id ?? ""),
    columns: Array.isArray(board.columns)
      ? board.columns.map((column: Record<string, any>) => ({
          id: String(column.id ?? column.column_id ?? ""),
          name: String(column.name ?? column.title ?? column.id ?? "")
        }))
      : undefined
  };
}

function normalizeCard(card: Record<string, any> = {}) {
  return {
    id: String(card.id ?? card.card_id ?? card.number ?? card.card_number ?? ""),
    number: card.number ?? card.card_number,
    title: String(card.title ?? card.name ?? card.subject ?? card.id ?? ""),
    boardId: String(cardBoardId(card) ?? ""),
    columnId: cardColumnId(card) ?? undefined,
    tags: Array.isArray(card.tags) ? card.tags.map(String) : undefined,
    golden: card.golden === true
  };
}

function normalizeComment(comment: Record<string, any> = {}, cardId: string | number) {
  return {
    id: String(comment.id ?? comment.comment_id ?? ""),
    cardId: String(comment.card_id ?? comment.cardId ?? cardId),
    body: commentBody(comment),
    createdAt: comment.created_at ?? comment.createdAt
  };
}

function normalizeWebhook(webhook: Record<string, any> = {}) {
  return {
    id: String(webhook.id ?? webhook.webhook_id ?? ""),
    boardId: String(webhook.board_id ?? webhook.boardId ?? ""),
    url: String(webhook.url ?? webhook.callback_url ?? "")
  };
}
