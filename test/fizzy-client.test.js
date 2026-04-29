import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEtagCache } from "../src/etag-cache.js";
import { createFizzyClient } from "../src/fizzy-client.js";

async function clientFixture(responses, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "fizzy-symphony-client-etags-"));
  const config = {
    fizzy: {
      account: "acct",
      api_url: "https://app.fizzy.test/api",
      token: "secret-token"
    },
    boards: { entries: [{ id: "board_1", enabled: true }] },
    polling: { use_etags: true, use_api_filters: true },
    observability: { state_dir: stateDir }
  };
  const calls = [];
  const cache = createEtagCache({ config });
  await cache.load();

  const client = createFizzyClient({
    config,
    etagCache: cache,
    normalize: options.normalize,
    transport: async (request) => {
      calls.push(request);
      const next = responses.shift();
      assert.ok(next, `unexpected request ${request.method} ${request.path}`);
      return next;
    }
  });

  return { client, cache, calls };
}

test("Fizzy client stores ETags and replays If-None-Match for board, card, comment, tag, user, webhook, and golden reads", async () => {
  const cases = [
    {
      label: "board",
      read: (client) => client.getBoard("board_1"),
      expectedPath: "/boards/board_1",
      payload: { id: "board_1", name: "Agents" }
    },
    {
      label: "card",
      read: (client) => client.getCard("card_1"),
      expectedPath: "/cards/card_1",
      payload: { id: "card_1", title: "Work" }
    },
    {
      label: "comment",
      read: (client) => client.listComments("card_1"),
      expectedPath: "/cards/card_1/comments",
      payload: [{ id: "comment_1", body: "hello" }]
    },
    {
      label: "tag",
      read: (client) => client.listTags(),
      expectedPath: "/accounts/acct/tags",
      payload: [{ id: "tag_1", name: "agent-instructions" }]
    },
    {
      label: "user",
      read: (client) => client.listUsers(),
      expectedPath: "/accounts/acct/users",
      payload: [{ id: "user_1", name: "Bot" }]
    },
    {
      label: "webhook",
      read: (client) => client.listWebhooks(),
      expectedPath: "/accounts/acct/webhooks",
      payload: [{ id: "webhook_1", active: true }]
    },
    {
      label: "golden",
      read: (client) => client.listGoldenCards({ board_ids: ["board_1"] }),
      expectedPath: "/cards",
      expectedQuery: { board_ids: ["board_1"], indexed_by: "golden" },
      payload: [{ id: "golden_1", golden: true, tags: ["agent-instructions"] }]
    }
  ];

  for (const scenario of cases) {
    let normalizeCalls = 0;
    const { client, calls } = await clientFixture([
      { status: 200, headers: { etag: `"${scenario.label}-v1"` }, body: scenario.payload },
      { status: 304, headers: {}, body: null }
    ], {
      normalize: (resource, body) => {
        normalizeCalls += 1;
        return { resource_type: resource.type, body };
      }
    });

    const first = await scenario.read(client);
    const second = await scenario.read(client);

    assert.equal(calls[0].path, scenario.expectedPath, scenario.label);
    assert.deepEqual(calls[0].query ?? {}, scenario.expectedQuery ?? {}, scenario.label);
    assert.equal(calls[0].headers["If-None-Match"], undefined, scenario.label);
    assert.equal(calls[1].headers["If-None-Match"], `"${scenario.label}-v1"`, scenario.label);
    assert.equal(first.status, 200, scenario.label);
    assert.equal(first.not_modified, false, scenario.label);
    assert.equal(second.status, 304, scenario.label);
    assert.equal(second.not_modified, true, scenario.label);
    assert.deepEqual(second.snapshot, first.snapshot, scenario.label);
    assert.equal(normalizeCalls, 1, scenario.label);
  }
});

test("Fizzy client treats missing or invalid cache entries as ordinary full reads", async () => {
  const { client, cache, calls } = await clientFixture([
    { status: 200, headers: { etag: "\"card-v1\"" }, body: { id: "card_1", title: "fresh" } },
    { status: 200, headers: { etag: "\"card-v2\"" }, body: { id: "card_1", title: "changed" } }
  ]);

  const first = await client.getCard("card_1");
  cache.set({ type: "card", id: "card_1" }, { etag: 15, snapshot: { id: "card_1", title: "bad" } });
  const second = await client.getCard("card_1");

  assert.equal(calls[0].headers["If-None-Match"], undefined);
  assert.equal(calls[1].headers["If-None-Match"], undefined);
  assert.equal(first.snapshot.title, "fresh");
  assert.equal(second.snapshot.title, "changed");
  assert.equal(cache.stats().invalid, 1);
});
