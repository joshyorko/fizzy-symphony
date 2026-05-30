// Fixture-backed FizzyPort fake.
//
// Keeps unit tests independent of live Fizzy and the @37signals/fizzy SDK.
// The daemon and cockpit only ever see the FizzyPort interface, so swapping
// this for the SDK adapter or the HTTP adapter requires no downstream change.

import type {
  CreateCommentInput,
  FizzyBoard,
  FizzyCard,
  FizzyComment,
  FizzyPort,
  FizzyWebhook,
  GetBoardInput,
  GetCardInput,
  ListBoardsInput,
  ListCardsInput,
  ListCommentsInput,
  ListWebhooksInput,
  MoveCardInput,
  UpdateCommentInput,
  VerifyWebhookInput
} from "../core/types.ts";

export interface FizzyFakeSeed {
  boards?: FizzyBoard[];
  cards?: FizzyCard[];
  comments?: FizzyComment[];
  webhooks?: FizzyWebhook[];
}

export function createFakeFizzyPort(seed: FizzyFakeSeed = {}): FizzyPort {
  const boards = (seed.boards ?? []).map((board) => ({ ...board }));
  const cards = (seed.cards ?? []).map((card) => ({ ...card }));
  const comments = (seed.comments ?? []).map((comment) => ({ ...comment }));
  const webhooks = (seed.webhooks ?? []).map((webhook) => ({ ...webhook }));
  let commentCounter = comments.length;

  return {
    describe() {
      return { kind: "fake", sdk: false, note: "fixture-backed FizzyPort for tests" };
    },
    async listBoards(_input?: ListBoardsInput): Promise<FizzyBoard[]> {
      return boards.map((board) => ({ ...board }));
    },
    async getBoard(input: GetBoardInput): Promise<FizzyBoard> {
      const board = boards.find((entry) => entry.id === input.boardId);
      if (!board) throw new Error(`Unknown board: ${input.boardId}`);
      return { ...board };
    },
    async listCards(input: ListCardsInput): Promise<FizzyCard[]> {
      return cards
        .filter((card) => card.boardId === input.boardId)
        .filter((card) => (input.columnId ? card.columnId === input.columnId : true))
        .map((card) => ({ ...card }));
    },
    async getCard(input: GetCardInput): Promise<FizzyCard> {
      const card = cards.find((entry) => entry.id === input.cardId);
      if (!card) throw new Error(`Unknown card: ${input.cardId}`);
      return { ...card };
    },
    async listComments(input: ListCommentsInput): Promise<FizzyComment[]> {
      return comments.filter((comment) => comment.cardId === input.cardId).map((c) => ({ ...c }));
    },
    async createComment(input: CreateCommentInput): Promise<FizzyComment> {
      commentCounter += 1;
      const comment: FizzyComment = {
        id: `comment_${commentCounter}`,
        cardId: input.cardId,
        body: input.body,
        createdAt: new Date(0).toISOString()
      };
      comments.push(comment);
      return { ...comment };
    },
    async updateComment(input: UpdateCommentInput): Promise<FizzyComment> {
      const comment = comments.find((entry) => entry.id === input.commentId);
      if (!comment) throw new Error(`Unknown comment: ${input.commentId}`);
      comment.body = input.body;
      return { ...comment };
    },
    async moveCard(input: MoveCardInput): Promise<FizzyCard> {
      const card = cards.find((entry) => entry.id === input.cardId);
      if (!card) throw new Error(`Unknown card: ${input.cardId}`);
      card.columnId = input.targetColumnId;
      return { ...card };
    },
    async listWebhooks(input: ListWebhooksInput): Promise<FizzyWebhook[]> {
      return webhooks.filter((webhook) => webhook.boardId === input.boardId).map((w) => ({ ...w }));
    },
    async verifyWebhook(_input: VerifyWebhookInput): Promise<boolean> {
      return true;
    }
  };
}
