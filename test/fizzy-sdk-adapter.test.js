import test from "node:test";
import assert from "node:assert/strict";

import { createCliFizzyClient } from "../src/client-factories.js";
import { createFizzyClient } from "../src/fizzy-client.js";

function configFixture() {
  return {
    fizzy: {
      account: "acct",
      api_url: "https://app.fizzy.test/api",
      token: "secret-token"
    }
  };
}

function createSdkFixture() {
  const calls = [];
  let webhook = {
    id: "webhook_1",
    name: "Old name",
    payload_url: "https://listener.example.test/webhook",
    active: false,
    subscribed_actions: ["card_closed"]
  };

  function rootClient(baseUrl) {
    return {
      identity: {
        async me() {
          calls.push(["identity.me", baseUrl]);
          return { user: { id: "user_1" }, accounts: [{ id: "acct", name: "Team Account" }] };
        }
      },
      miscellaneous: {
        async accountSettings() {
          calls.push(["misc.accountSettings", baseUrl]);
          return { auto_postpone_period_in_days: 0 };
        }
      }
    };
  }

  function accountClient(baseUrl) {
    return {
      boards: {
        async list() {
          calls.push(["boards.list", baseUrl]);
          return [{ id: "board_1", name: "Agents" }];
        },
        async get(boardId) {
          calls.push(["boards.get", baseUrl, boardId]);
          return { id: boardId, name: "Agents" };
        },
        async create(body) {
          calls.push(["boards.create", baseUrl, body]);
          return { id: "board_new", ...body };
        }
      },
      columns: {
        async list(boardId) {
          calls.push(["columns.list", baseUrl, boardId]);
          return [{ id: "col_ready", name: "Ready for Agents" }];
        },
        async create(boardId, body) {
          calls.push(["columns.create", baseUrl, boardId, body]);
          return { id: "col_new", ...body };
        }
      },
      cards: {
        async list(options = {}) {
          calls.push(["cards.list", baseUrl, options]);
          return [{ id: "card_uuid", number: 42, title: "Agent card", board_id: options.boardIds?.[0] ?? "board_1" }];
        },
        async get(cardNumber) {
          calls.push(["cards.get", baseUrl, cardNumber]);
          return { id: "card_uuid", number: cardNumber, title: "Agent card" };
        },
        async create(body) {
          calls.push(["cards.create", baseUrl, body]);
          return { id: "card_new", number: 99, ...body };
        },
        async triage(cardNumber, body) {
          calls.push(["cards.triage", baseUrl, cardNumber, body]);
        },
        async gold(cardNumber) {
          calls.push(["cards.gold", baseUrl, cardNumber]);
        },
        async ungold(cardNumber) {
          calls.push(["cards.ungold", baseUrl, cardNumber]);
        },
        async assign(cardNumber, body) {
          calls.push(["cards.assign", baseUrl, cardNumber, body]);
        },
        async tag(cardNumber, body) {
          calls.push(["cards.tag", baseUrl, cardNumber, body]);
        },
        async close(cardNumber) {
          calls.push(["cards.close", baseUrl, cardNumber]);
        },
        async reopen(cardNumber) {
          calls.push(["cards.reopen", baseUrl, cardNumber]);
        },
        async untriage(cardNumber) {
          calls.push(["cards.untriage", baseUrl, cardNumber]);
        },
        async watch(cardNumber) {
          calls.push(["cards.watch", baseUrl, cardNumber]);
        },
        async unwatch(cardNumber) {
          calls.push(["cards.unwatch", baseUrl, cardNumber]);
        }
      },
      comments: {
        async list(cardNumber) {
          calls.push(["comments.list", baseUrl, cardNumber]);
          return [{ id: "comment_1", body: "hello" }];
        },
        async get(cardNumber, commentId) {
          calls.push(["comments.get", baseUrl, cardNumber, commentId]);
          return { id: commentId, body: "hello" };
        },
        async create(cardNumber, body) {
          calls.push(["comments.create", baseUrl, cardNumber, body]);
          return { id: "comment_1", body: body.body };
        },
        async update(cardNumber, commentId, body) {
          calls.push(["comments.update", baseUrl, cardNumber, commentId, body]);
          return { id: commentId, body: body.body };
        },
        async delete(cardNumber, commentId) {
          calls.push(["comments.delete", baseUrl, cardNumber, commentId]);
        }
      },
      steps: {
        async list(cardNumber) {
          calls.push(["steps.list", baseUrl, cardNumber]);
          return [{ id: "step_1", content: "Check logs" }];
        },
        async get(cardNumber, stepId) {
          calls.push(["steps.get", baseUrl, cardNumber, stepId]);
          return { id: stepId, content: "Check logs" };
        },
        async create(cardNumber, body) {
          calls.push(["steps.create", baseUrl, cardNumber, body]);
          return { id: "step_1", ...body };
        },
        async update(cardNumber, stepId, body) {
          calls.push(["steps.update", baseUrl, cardNumber, stepId, body]);
          return { id: stepId, ...body };
        },
        async delete(cardNumber, stepId) {
          calls.push(["steps.delete", baseUrl, cardNumber, stepId]);
        }
      },
      tags: {
        async list() {
          calls.push(["tags.list", baseUrl]);
          return [{ id: "tag_1", name: "agent-instructions" }];
        }
      },
      users: {
        async list() {
          calls.push(["users.list", baseUrl]);
          return [{ id: "user_1", name: "Human" }];
        },
        async get(userId) {
          calls.push(["users.get", baseUrl, userId]);
          return { id: userId, name: "Human" };
        }
      },
      webhooks: {
        async list(boardId) {
          calls.push(["webhooks.list", baseUrl, boardId]);
          return [webhook];
        },
        async get(boardId, webhookId) {
          calls.push(["webhooks.get", baseUrl, boardId, webhookId]);
          return webhook;
        },
        async create(boardId, body) {
          calls.push(["webhooks.create", baseUrl, boardId, body]);
          webhook = { id: "webhook_2", payload_url: body.url, active: true, name: body.name, subscribed_actions: body.subscribedActions };
          return webhook;
        },
        async update(boardId, webhookId, body) {
          calls.push(["webhooks.update", baseUrl, boardId, webhookId, body]);
          webhook = {
            ...webhook,
            id: webhookId,
            name: body.name ?? webhook.name,
            subscribed_actions: body.subscribedActions ?? webhook.subscribed_actions
          };
          return webhook;
        },
        async activate(boardId, webhookId) {
          calls.push(["webhooks.activate", baseUrl, boardId, webhookId]);
          webhook = { ...webhook, id: webhookId, active: true };
        },
        async listWebhookDeliveries(boardId, webhookId) {
          calls.push(["webhooks.listWebhookDeliveries", baseUrl, boardId, webhookId]);
          return [{ id: "delivery_1" }];
        }
      }
    };
  }

  return {
    calls,
    sdkFactory({ baseUrl }) {
      if (baseUrl === "https://app.fizzy.test/api") return rootClient(baseUrl);
      if (baseUrl === "https://app.fizzy.test/api/acct") return accountClient(baseUrl);
      throw new Error(`unexpected SDK base URL: ${baseUrl}`);
    }
  };
}

test("createFizzyClient uses the official SDK adapter for live account-scoped operations", async () => {
  const sdk = createSdkFixture();
  const client = createFizzyClient({
    config: configFixture(),
    sdkFactory: sdk.sdkFactory
  });

  const identity = await client.getIdentity();
  const board = await client.getBoard("board_1");
  const cards = await client.listCards({
    query: {
      board_ids: ["board_1"],
      column_ids: ["col_ready"],
      terms: ["agent work"],
      indexed_by: "golden"
    }
  });
  const comment = await client.createComment({ card: { number: 42 }, body: "<p>hello</p>" });
  await client.moveCardToColumn({ card: { number: 42 }, column_id: "col_done" });
  await client.markCardGolden({ card: { number: 42 } });
  const webhook = await client.ensureWebhook({
    board_id: "board_1",
    url: "https://listener.example.test/webhook",
    subscribed_actions: ["card_triaged", "comment_created"]
  });

  assert.equal(identity.user.id, "user_1");
  assert.deepEqual(board.columns, [{ id: "col_ready", name: "Ready for Agents" }]);
  assert.deepEqual(board.cards, [{ id: "card_uuid", number: 42, title: "Agent card", board_id: "board_1" }]);
  assert.deepEqual(cards, [{ id: "card_uuid", number: 42, title: "Agent card", board_id: "board_1" }]);
  assert.deepEqual(comment, { id: "comment_1", body: "<p>hello</p>" });
  assert.equal(webhook.active, true);

  assert.deepEqual(
    sdk.calls.find((call) => call[0] === "cards.list" && call[2].columnIds),
    ["cards.list", "https://app.fizzy.test/api/acct", {
      boardIds: ["board_1"],
      columnIds: ["col_ready"],
      indexedBy: "golden",
      terms: ["agent work"]
    }]
  );
  assert.deepEqual(
    sdk.calls.find((call) => call[0] === "comments.create"),
    ["comments.create", "https://app.fizzy.test/api/acct", 42, { body: "<p>hello</p>" }]
  );
  assert.deepEqual(
    sdk.calls.find((call) => call[0] === "cards.triage"),
    ["cards.triage", "https://app.fizzy.test/api/acct", 42, { columnId: "col_done" }]
  );
  assert.deepEqual(
    sdk.calls.find((call) => call[0] === "cards.gold"),
    ["cards.gold", "https://app.fizzy.test/api/acct", 42]
  );
  assert.deepEqual(
    sdk.calls.find((call) => call[0] === "webhooks.update"),
    ["webhooks.update", "https://app.fizzy.test/api/acct", "board_1", "webhook_1", {
      name: "fizzy-symphony",
      subscribedActions: ["card_triaged", "comment_created"]
    }]
  );
  assert.deepEqual(
    sdk.calls.find((call) => call[0] === "webhooks.activate"),
    ["webhooks.activate", "https://app.fizzy.test/api/acct", "board_1", "webhook_1"]
  );
});

test("createCliFizzyClient keeps the CLI path on the SDK-backed adapter when no fetch override is supplied", async () => {
  const sdk = createSdkFixture();
  const client = createCliFizzyClient({
    config: configFixture(),
    sdkFactory: sdk.sdkFactory
  });

  const identity = await client.getIdentity();

  assert.equal(identity.user.id, "user_1");
  assert.deepEqual(sdk.calls, [["identity.me", "https://app.fizzy.test/api"]]);
});
