import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEtagCache } from "../src/etag-cache.js";
import {
  createFizzyClient,
  resultCommentBody,
  verifyWebhookRequest,
  verifyWebhookSignature
} from "../src/fizzy-client.js";

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

async function fetchClientFixture(responses, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "fizzy-symphony-client-fetch-"));
  const config = {
    fizzy: {
      account: "acct",
      api_url: "https://app.fizzy.test/api/",
      token: "secret-token",
      bot_user_id: "user_bot"
    },
    boards: { entries: [{ id: "board_uuid", enabled: true }] },
    polling: { use_etags: true, use_api_filters: true },
    observability: { state_dir: stateDir },
    webhook: { secret: "webhook-secret" }
  };
  const calls = [];
  const cache = createEtagCache({ config });
  await cache.load();
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    assert.ok(next, `unexpected fetch ${init.method ?? "GET"} ${url}`);
    return responseFixture(next);
  };
  const client = createFizzyClient({
    config,
    etagCache: cache,
    fetch,
    normalize: options.normalize
  });

  return { client, cache, calls, config };
}

function responseFixture(response) {
  const {
    status = 200,
    statusText,
    headers = {},
    body = null
  } = response;
  const responseBody =
    body === null || body === undefined
      ? null
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  return new Response(responseBody, {
    status,
    statusText,
    headers: {
      ...(responseBody && !headers["content-type"] && !headers["Content-Type"]
        ? { "content-type": "application/json" }
        : {}),
      ...headers
    }
  });
}

test("Fizzy fetch transport sends bearer JSON headers on account-scoped Rails routes and encodes array filters", async () => {
  const { client, calls } = await fetchClientFixture([
    { status: 200, body: [{ id: "card_1", number: 42 }] }
  ]);

  const cards = await client.listCards({
    query: {
      board_ids: ["board_1", "board_2"],
      column_ids: ["col_ready"],
      terms: ["agent work"],
      indexed_by: "golden"
    }
  });

  assert.deepEqual(cards, [{ id: "card_1", number: 42 }]);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://app.fizzy.test/api/acct/cards");
  assert.deepEqual(url.searchParams.getAll("board_ids[]"), ["board_1", "board_2"]);
  assert.deepEqual(url.searchParams.getAll("column_ids[]"), ["col_ready"]);
  assert.deepEqual(url.searchParams.getAll("terms[]"), ["agent work"]);
  assert.equal(url.searchParams.get("indexed_by"), "golden");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
});

test("result comments are normalized to Fizzy rich-text HTML", () => {
  assert.equal(
    resultCommentBody({ result: { output_summary: "Changed files\nRan tests" } }),
    "<p>Changed files<br>Ran tests</p>"
  );
  assert.equal(
    resultCommentBody({ result: { output: "Summary\n\n- item" } }),
    "<p>Summary</p>\n<p>- item</p>"
  );
  assert.equal(
    resultCommentBody({ result: { output_html: "<p><strong>Done</strong></p>" } }),
    "<p><strong>Done</strong></p>"
  );
  assert.equal(
    resultCommentBody({ result: { summary: "<script>alert(1)</script>" } }),
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"
  );
});

test("Fizzy client normalizes account slugs before building account-scoped routes", async () => {
  const { client, calls, config } = await fetchClientFixture([
    { status: 200, body: [{ id: "board_1", name: "Smoke" }] },
    { status: 200, body: [{ id: "board_2", name: "Explicit" }] }
  ]);
  config.fizzy.account = "/1";

  await client.listBoards();
  await client.listBoards("/2/");

  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ["/api/1/boards", "/api/2/boards"]
  );
});

test("Fizzy fetch transport parses bare-array list responses and exposes 304 reads with cached snapshots", async () => {
  const { client, calls } = await fetchClientFixture([
    { status: 200, headers: { etag: "\"tags-v1\"" }, body: [{ id: "tag_1", title: "agent-instructions" }] },
    { status: 304, headers: {}, body: null }
  ]);

  const first = await client.readTags();
  const second = await client.readTags();

  assert.deepEqual(first.data, [{ id: "tag_1", title: "agent-instructions" }]);
  assert.equal(first.not_modified, false);
  assert.equal(second.status, 304);
  assert.equal(second.not_modified, true);
  assert.deepEqual(second.data, first.data);
  assert.equal(calls[1].init.headers["If-None-Match"], "\"tags-v1\"");
});

test("Fizzy client uses card numbers for card routes and UUIDs for board, column, tag, user, and webhook routes", async () => {
  const { client, calls } = await fetchClientFixture([
    { status: 200, body: { id: "card_uuid", number: 42 } },
    { status: 200, body: [] },
    {
      status: 201,
      headers: { location: "https://app.fizzy.test/api/acct/cards/42/comments/comment_uuid.json" },
      body: null
    },
    { status: 201, body: { id: "step_uuid" } },
    { status: 204 },
    { status: 204 },
    { status: 204 },
    { status: 200, body: { id: "board_uuid" } },
    { status: 200, body: [] },
    { status: 200, body: { id: "tag_uuid" } },
    { status: 200, body: { id: "user_uuid" } },
    { status: 200, body: [] }
  ]);

  await client.getCard({ number: 42, id: "card_uuid" });
  await client.listComments({ card: { number: 42, id: "card_uuid" } });
  const comment = await client.createComment({ card: { number: 42 }, body: "<p>hello</p>" });
  await client.createStep({ card: { number: 42 }, content: "Check logs", completed: false });
  await client.moveCardToColumn({ card: { number: 42 }, column_id: "column_uuid" });
  await client.markCardGolden({ card: { number: 42 } });
  await client.assignCard({ card: { number: 42 }, user_id: "user_uuid" });
  await client.readBoard("board_uuid");
  await client.listColumns("board_uuid");
  await client.getTag("tag_uuid");
  await client.getUser("user_uuid");
  await client.listWebhooks({ board_id: "board_uuid" });

  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/api/acct/cards/42",
      "/api/acct/cards/42/comments",
      "/api/acct/cards/42/comments",
      "/api/acct/cards/42/steps",
      "/api/acct/cards/42/triage",
      "/api/acct/cards/42/goldness",
      "/api/acct/cards/42/assignments",
      "/api/acct/boards/board_uuid",
      "/api/acct/boards/board_uuid/columns",
      "/api/acct/tags/tag_uuid",
      "/api/acct/users/user_uuid",
      "/api/acct/boards/board_uuid/webhooks"
    ]
  );
  assert.equal(comment.id, "comment_uuid");
  assert.equal(calls[4].init.body, JSON.stringify({ column_id: "column_uuid" }));
  assert.equal(calls[6].init.body, JSON.stringify({ assignee_id: "user_uuid" }));
});

test("Fizzy client refuses UUID-only card route inputs", async () => {
  const { client } = await fetchClientFixture([]);

  await assert.rejects(
    () => client.getCard("card_uuid"),
    (error) => error.code === "FIZZY_CARD_NUMBER_REQUIRED"
  );
});

test("Fizzy client manages board webhooks by updating subscriptions and reactivating inactive matches", async () => {
  const { client, calls } = await fetchClientFixture([
    {
      status: 200,
      body: [
        {
          id: "webhook_uuid",
          name: "Old name",
          payload_url: "https://listener.example.test/webhook",
          active: false,
          subscribed_actions: ["card_closed"]
        }
      ]
    },
    {
      status: 200,
      body: {
        id: "webhook_uuid",
        name: "fizzy-symphony",
        payload_url: "https://listener.example.test/webhook",
        active: false,
        subscribed_actions: ["card_closed", "card_triaged"]
      }
    },
    {
      status: 201,
      body: {
        id: "webhook_uuid",
        name: "fizzy-symphony",
        active: true,
        subscribed_actions: ["card_closed", "card_triaged"]
      }
    }
  ]);

  const webhook = await client.ensureWebhook({
    board_id: "board_uuid",
    callback_url: "https://listener.example.test/webhook",
    subscribed_actions: ["card_closed", "card_triaged"]
  });

  assert.equal(webhook.id, "webhook_uuid");
  assert.equal(webhook.active, true);
  assert.deepEqual(
    calls.map((call) => `${call.init.method ?? "GET"} ${new URL(call.url).pathname}`),
    [
      "GET /api/acct/boards/board_uuid/webhooks",
      "PATCH /api/acct/boards/board_uuid/webhooks/webhook_uuid",
      "POST /api/acct/boards/board_uuid/webhooks/webhook_uuid/activation"
    ]
  );
  assert.equal(calls[1].init.body, JSON.stringify({
    webhook: {
      name: "fizzy-symphony",
      subscribed_actions: ["card_closed", "card_triaged"]
    }
  }));
});

test("Fizzy client creates a managed webhook when no matching callback exists", async () => {
  const { client, calls } = await fetchClientFixture([
    { status: 200, body: [] },
    {
      status: 201,
      body: {
        id: "webhook_created",
        payload_url: "https://listener.example.test/webhook",
        active: true
      }
    }
  ]);

  const webhook = await client.ensureWebhook({
    board_id: "board_uuid",
    callback_url: "https://listener.example.test/webhook",
    name: "fizzy-symphony",
    subscribed_actions: ["card_closed"]
  });

  assert.equal(webhook.id, "webhook_created");
  assert.deepEqual(
    calls.map((call) => `${call.init.method ?? "GET"} ${new URL(call.url).pathname}`),
    [
      "GET /api/acct/boards/board_uuid/webhooks",
      "POST /api/acct/boards/board_uuid/webhooks"
    ]
  );
  assert.equal(calls[1].init.body, JSON.stringify({
    webhook: {
      name: "fizzy-symphony",
      url: "https://listener.example.test/webhook",
      subscribed_actions: ["card_closed"]
    }
  }));
});

test("Fizzy client inspects managed webhook delivery failures with safe metadata only", async () => {
  const { client, calls } = await fetchClientFixture([
    {
      status: 200,
      body: [
        {
          id: "delivery_failed",
          status: "failed",
          action: "comment_created",
          event_id: "event_1",
          response_status: 500,
          response_body: "server exploded secret-token",
          request_headers: { authorization: "Bearer secret-token" },
          error: { code: "HTTP_500", message: "callback failed with webhook-secret" },
          attempted_at: "2026-05-07T12:00:00.000Z"
        },
        {
          id: "delivery_ok",
          status: "delivered",
          action: "card_closed",
          response_status: 200
        }
      ]
    }
  ]);

  const report = await client.inspectWebhookDeliveries({
    board_id: "board_uuid",
    webhook_id: "webhook_uuid"
  });

  assert.equal(report.supported, true);
  assert.equal(report.board_id, "board_uuid");
  assert.equal(report.webhook_id, "webhook_uuid");
  assert.deepEqual(
    calls.map((call) => `${call.init.method ?? "GET"} ${new URL(call.url).pathname}`),
    ["GET /api/acct/boards/board_uuid/webhooks/webhook_uuid/deliveries"]
  );
  assert.deepEqual(report.deliveries, [
    {
      id: "delivery_failed",
      status: "failed",
      action: "comment_created",
      event_id: "event_1",
      response_status: 500,
      attempted_at: "2026-05-07T12:00:00.000Z",
      ok: false,
      error_code: "HTTP_500",
      message: "callback failed with [REDACTED]"
    },
    {
      id: "delivery_ok",
      status: "delivered",
      action: "card_closed",
      response_status: 200,
      ok: true
    }
  ]);
  assert.deepEqual(report.recent_delivery_errors, [
    {
      code: "WEBHOOK_DELIVERY_FAILED",
      message: "callback failed with [REDACTED]",
      board_id: "board_uuid",
      webhook_id: "webhook_uuid",
      delivery_id: "delivery_failed",
      action: "comment_created",
      event_id: "event_1",
      response_status: 500,
      status: "failed",
      attempted_at: "2026-05-07T12:00:00.000Z"
    }
  ]);
  assert.equal(JSON.stringify(report).includes("secret-token"), false);
  assert.equal(JSON.stringify(report).includes("webhook-secret"), false);
  assert.equal(JSON.stringify(report).includes("authorization"), false);
  assert.equal(JSON.stringify(report).includes("response_body"), false);
});

test("Fizzy API errors expose safe status and rate-limit metadata without credentials", async () => {
  const { client } = await fetchClientFixture([
    {
      status: 429,
      statusText: "Too Many Requests",
      headers: {
        "retry-after": "15",
        "x-request-id": "req_123",
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "2026-04-29T19:00:00Z"
      },
      body: { error: "slow down", token: "secret-token" }
    }
  ]);

  await assert.rejects(
    () => client.listCards(),
    (error) => {
      assert.equal(error.name, "FizzyApiError");
      assert.equal(error.status, 429);
      assert.equal(error.metadata.path, "/acct/cards");
      assert.equal(error.metadata.request_id, "req_123");
      assert.equal(error.metadata.retry_after, "15");
      assert.deepEqual(error.metadata.rate_limit, {
        limit: "100",
        remaining: "0",
        reset: "2026-04-29T19:00:00Z"
      });
      assert.equal(JSON.stringify(error.metadata).includes("secret-token"), false);
      return true;
    }
  );
});

test("Fizzy webhook verification uses the raw body, configured secret, hex signature, and timestamp freshness", () => {
  const secret = "webhook-secret";
  const rawBody = "{\"id\":\"event_1\",\"action\":\"card_triaged\"}";
  const formattedBody = "{\n  \"id\": \"event_1\",\n  \"action\": \"card_triaged\"\n}";
  const now = new Date("2026-04-29T18:00:00.000Z");
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
  const headers = {
    "X-Webhook-Signature": signature,
    "X-Webhook-Timestamp": "2026-04-29T17:59:30.000Z"
  };

  assert.equal(verifyWebhookSignature(rawBody, signature, secret), true);
  assert.equal(verifyWebhookSignature(formattedBody, signature, secret), false);
  assert.equal(verifyWebhookRequest({ rawBody, headers, secret, now }).ok, true);
  assert.deepEqual(verifyWebhookRequest({ rawBody, headers: { ...headers, "X-Webhook-Signature": "bad" }, secret, now }), {
    ok: false,
    code: "INVALID_WEBHOOK_SIGNATURE",
    status: 401,
    verified: false
  });
  assert.equal(verifyWebhookRequest({ rawBody: formattedBody, headers, secret, now }).ok, false);
  assert.equal(verifyWebhookRequest({
    rawBody,
    headers: { ...headers, "X-Webhook-Signature": signature.slice(0, 12) },
    secret,
    now
  }).code, "INVALID_WEBHOOK_SIGNATURE");
  assert.deepEqual(verifyWebhookRequest({
    rawBody,
    headers: { ...headers, "X-Webhook-Timestamp": "2026-04-29T17:50:00.000Z" },
    secret,
    now
  }), {
    ok: false,
    code: "STALE_WEBHOOK_EVENT",
    status: 400,
    verified: true
  });
  assert.deepEqual(verifyWebhookRequest({ rawBody, headers: {}, secret: "", now }), {
    ok: true,
    verified: false,
    reason: "no_secret_configured"
  });
});

test("Fizzy client stores ETags and replays If-None-Match for board, card, comment, tag, user, webhook, and golden reads", async () => {
  const cases = [
    {
      label: "board",
      read: (client) => client.readBoard("board_1"),
      expectedPath: "/acct/boards/board_1",
      payload: { id: "board_1", name: "Agents" }
    },
    {
      label: "card",
      read: (client) => client.readCard(42),
      expectedPath: "/acct/cards/42",
      payload: { id: "card_1", number: 42, title: "Work" }
    },
    {
      label: "comment",
      read: (client) => client.readComments({ card: { number: 42 } }),
      expectedPath: "/acct/cards/42/comments",
      payload: [{ id: "comment_1", body: "hello" }]
    },
    {
      label: "tag",
      read: (client) => client.readTags(),
      expectedPath: "/acct/tags",
      payload: [{ id: "tag_1", name: "agent-instructions" }]
    },
    {
      label: "user",
      read: (client) => client.readUsers(),
      expectedPath: "/acct/users",
      payload: [{ id: "user_1", name: "Bot" }]
    },
    {
      label: "webhook",
      read: (client) => client.readWebhooks({ board_id: "board_1" }),
      expectedPath: "/acct/boards/board_1/webhooks",
      payload: [{ id: "webhook_1", active: true }]
    },
    {
      label: "golden",
      read: (client) => client.readGoldenCards({ board_ids: ["board_1"] }),
      expectedPath: "/acct/cards",
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
    { status: 200, headers: { etag: "\"card-v1\"" }, body: { id: "card_1", number: 42, title: "fresh" } },
    { status: 200, headers: { etag: "\"card-v2\"" }, body: { id: "card_1", number: 42, title: "changed" } }
  ]);

  const first = await client.readCard(42);
  cache.set({ type: "card", id: 42 }, { etag: 15, snapshot: { id: "card_1", title: "bad" } });
  const second = await client.readCard(42);

  assert.equal(calls[0].headers["If-None-Match"], undefined);
  assert.equal(calls[1].headers["If-None-Match"], undefined);
  assert.equal(first.snapshot.title, "fresh");
  assert.equal(second.snapshot.title, "changed");
  assert.equal(cache.stats().invalid, 1);
});
