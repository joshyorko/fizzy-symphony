import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  createLocalHttpHandler,
  createRecentWebhookEventCache,
  createWebhookHintQueue
} from "../src/server.js";
import { bindServerListener } from "../src/listener.js";

test("local HTTP handler serves health, readiness, status, and card status JSON", async () => {
  const statusSnapshot = {
    schema_version: "fizzy-symphony-status-v1",
    runs: {
      queued: [],
      running: [{ id: "run_1", card_id: "card_1" }],
      completed: [],
      failed: [],
      cancelled: [],
      preempted: []
    }
  };
  const server = await bindServerListener(httpConfig().server, {
    requestListener: createLocalHttpHandler({
      config: httpConfig(),
      status: {
        health: () => ({ live: true, status: "live", ready: false }),
        ready: () => ({
          ready: false,
          status: "not_ready",
          blockers: [{ code: "DISPATCH_DISABLED", message: "Dispatch is disabled." }]
        }),
        status: () => statusSnapshot
      }
    })
  });

  try {
    const health = await fetchJson(`${server.endpoint.base_url}/health`);
    assert.equal(health.response.status, 200);
    assert.deepEqual(health.body, { live: true, status: "live", ready: false });

    const ready = await fetchJson(`${server.endpoint.base_url}/ready`);
    assert.equal(ready.response.status, 503);
    assert.equal(ready.body.blockers[0].code, "DISPATCH_DISABLED");

    const status = await fetchJson(`${server.endpoint.base_url}/status`);
    assert.equal(status.response.status, 200);
    assert.deepEqual(status.body, statusSnapshot);

    const cardStatus = await fetchJson(`${server.endpoint.base_url}/status/cards/card_1`);
    assert.equal(cardStatus.response.status, 200);
    assert.equal(cardStatus.body.card_id, "card_1");
    assert.deepEqual(cardStatus.body.runs.running.map((run) => run.id), ["run_1"]);
  } finally {
    await server.close();
  }
});

test("webhook verifies signatures, timestamps, dedupes event IDs, and enqueues candidate hints only", async () => {
  const config = httpConfig({
    webhook: { enabled: true, path: "/webhook", secret: "webhook-secret" }
  });
  const queue = createWebhookHintQueue();
  const server = await bindServerListener(config.server, {
    requestListener: createLocalHttpHandler({
      config,
      status: readyStatus(),
      enqueueWebhookHint: queue.enqueue,
      now: () => new Date("2026-04-29T12:00:00.000Z")
    })
  });

  try {
    const body = JSON.stringify({
      event_id: "event_1",
      action: "card_triaged",
      card: { id: "card_1", board_id: "board_1" }
    });
    const accepted = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature(body, config.webhook.secret),
        "x-webhook-timestamp": "2026-04-29T12:00:00.000Z"
      },
      body
    });

    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.body.status, "accepted");
    assert.deepEqual(accepted.body.hint, {
      intent: "spawn",
      reason: "card_triaged",
      event_id: "event_1",
      action: "card_triaged",
      card_id: "card_1",
      board_id: "board_1"
    });
    assert.deepEqual(queue.snapshot(), [{
      source: "webhook",
      intent: "spawn",
      reason: "card_triaged",
      event_id: "event_1",
      action: "card_triaged",
      card_id: "card_1",
      board_id: "board_1",
      received_at: "2026-04-29T12:00:00.000Z"
    }]);

    const duplicate = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature(body, config.webhook.secret),
        "x-webhook-timestamp": "2026-04-29T12:00:00.000Z"
      },
      body
    });
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.status, "duplicate");
    assert.equal(queue.size, 1);
  } finally {
    await server.close();
  }
});

test("webhook rejects stale timestamps before enqueueing", async () => {
  const config = httpConfig({
    webhook: { enabled: true, path: "/webhook", max_event_age_seconds: 300 }
  });
  const queue = createWebhookHintQueue();
  const server = await bindServerListener(config.server, {
    requestListener: createLocalHttpHandler({
      config,
      status: readyStatus(),
      enqueueWebhookHint: queue.enqueue,
      now: () => new Date("2026-04-29T12:10:00.000Z")
    })
  });

  try {
    const stale = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "event_old",
        action: "card_triaged",
        created_at: "2026-04-29T12:00:00.000Z",
        card: { id: "card_1", board_id: "board_1" }
      })
    });

    assert.equal(stale.response.status, 400);
    assert.equal(stale.body.error.code, "STALE_WEBHOOK_EVENT");
    assert.equal(queue.size, 0);
  } finally {
    await server.close();
  }
});

test("webhook rejects missing signatures and malformed payloads before enqueueing", async () => {
  const hints = [];
  const config = httpConfig({
    webhook: { enabled: true, path: "/webhook", secret: "webhook-secret" }
  });
  const server = await bindServerListener(config.server, {
    requestListener: createLocalHttpHandler({
      config,
      status: readyStatus(),
      enqueueWebhookHint: (hint) => hints.push(hint),
      now: () => new Date("2026-04-29T12:00:00.000Z")
    })
  });

  try {
    const missingSignature = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_id: "event_1", action: "card_triaged", card_id: "card_1" })
    });
    assert.equal(missingSignature.response.status, 401);
    assert.equal(missingSignature.body.error.code, "WEBHOOK_SIGNATURE_REQUIRED");

    const staleBody = JSON.stringify({ event_id: "event_stale", action: "card_triaged", card_id: "card_1" });
    const staleTimestamp = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature(staleBody, config.webhook.secret),
        "x-webhook-timestamp": "2026-04-29T11:00:00.000Z"
      },
      body: staleBody
    });
    assert.equal(staleTimestamp.response.status, 400);
    assert.equal(staleTimestamp.body.error.code, "STALE_WEBHOOK_EVENT");

    const invalidJson = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature("{not json", config.webhook.secret),
        "x-webhook-timestamp": "2026-04-29T12:00:00.000Z"
      },
      body: "{not json"
    });
    assert.equal(invalidJson.response.status, 400);
    assert.equal(invalidJson.body.error.code, "INVALID_WEBHOOK_PAYLOAD");
    assert.deepEqual(hints, []);
  } finally {
    await server.close();
  }
});

test("webhook ignores unsupported events without enqueueing partial spawn semantics", async () => {
  const queue = createWebhookHintQueue();
  const server = await bindServerListener(httpConfig().server, {
    requestListener: createLocalHttpHandler({
      config: httpConfig(),
      status: readyStatus(),
      enqueueWebhookHint: queue.enqueue,
      now: () => new Date("2026-04-29T12:00:00.000Z")
    })
  });

  try {
    const ignored = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "event_unsupported",
        action: "card_archived",
        card: { id: "card_1", board_id: "board_1" }
      })
    });

    assert.equal(ignored.response.status, 200);
    assert.equal(ignored.body.status, "ignored");
    assert.equal(ignored.body.reason, "unsupported_event");
    assert.deepEqual(queue.snapshot(), []);
  } finally {
    await server.close();
  }
});

test("webhook ignores self-authored comments unless a rerun signal is present", async () => {
  const queue = createWebhookHintQueue();
  const config = httpConfig({
    fizzy: { bot_user_id: "bot_1" }
  });
  const server = await bindServerListener(config.server, {
    requestListener: createLocalHttpHandler({
      config,
      status: readyStatus(),
      enqueueWebhookHint: queue.enqueue,
      now: () => new Date("2026-04-29T12:00:00.000Z")
    })
  });

  try {
    const selfComment = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "event_self",
        action: "comment_created",
        actor: { id: "bot_1" },
        card: { id: "card_1", board_id: "board_1", tags: [] }
      })
    });
    assert.equal(selfComment.response.status, 200);
    assert.equal(selfComment.body.status, "ignored");
    assert.equal(selfComment.body.reason, "self_authored_comment");

    const rerunComment = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "event_rerun",
        action: "comment_created",
        actor: { id: "bot_1" },
        card: { id: "card_1", board_id: "board_1", tags: ["agent-rerun"] }
      })
    });
    assert.equal(rerunComment.response.status, 202);
    assert.equal(rerunComment.body.status, "accepted");
    assert.equal(rerunComment.body.hint.intent, "spawn");
    assert.equal(rerunComment.body.hint.reason, "comment_created:rerun");
    assert.deepEqual(queue.snapshot(), [{
      source: "webhook",
      intent: "spawn",
      reason: "comment_created:rerun",
      event_id: "event_rerun",
      action: "comment_created",
      card_id: "card_1",
      board_id: "board_1",
      rerun_requested: true,
      received_at: "2026-04-29T12:00:00.000Z"
    }]);
  } finally {
    await server.close();
  }
});

test("webhook maps lifecycle cancellation and golden-ticket events to semantic hints", async () => {
  const queue = createWebhookHintQueue();
  const config = httpConfig();
  const server = await bindServerListener(config.server, {
    requestListener: createLocalHttpHandler({
      config,
      status: readyStatus(),
      enqueueWebhookHint: queue.enqueue,
      now: () => new Date("2026-04-29T12:00:00.000Z")
    })
  });

  try {
    const closed = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "event_closed",
        action: "card_closed",
        card: { id: "card_1", board_id: "board_1" }
      })
    });
    assert.equal(closed.response.status, 202);
    assert.equal(closed.body.hint.intent, "cancel_tick");
    assert.equal(closed.body.hint.reason, "card_closed");

    const golden = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "event_golden",
        action: "card_published",
        card: { id: "golden_1", board_id: "board_1", tags: ["agent-instructions"] }
      })
    });
    assert.equal(golden.response.status, 202);
    assert.equal(golden.body.hint.intent, "refresh_routes");
    assert.equal(golden.body.hint.reason, "golden_ticket_changed");

    assert.deepEqual(queue.snapshot().map((hint) => ({
      intent: hint.intent,
      reason: hint.reason,
      event_id: hint.event_id,
      card_id: hint.card_id
    })), [
      { intent: "cancel_tick", reason: "card_closed", event_id: "event_closed", card_id: "card_1" },
      { intent: "refresh_routes", reason: "golden_ticket_changed", event_id: "event_golden", card_id: "golden_1" }
    ]);
  } finally {
    await server.close();
  }
});

test("webhook event ID dedupe retention is bounded by count and TTL", () => {
  let now = new Date("2026-04-29T12:00:00.000Z");
  const cache = createRecentWebhookEventCache({
    maxSize: 2,
    ttlMs: 1000,
    now: () => now
  });

  cache.add("event_1");
  cache.add("event_2");
  cache.add("event_3");
  assert.equal(cache.has("event_1"), false);
  assert.equal(cache.has("event_2"), true);
  assert.equal(cache.has("event_3"), true);
  assert.equal(cache.size, 2);

  now = new Date("2026-04-29T12:00:02.000Z");
  assert.equal(cache.has("event_2"), false);
  assert.equal(cache.has("event_3"), false);
  assert.equal(cache.size, 0);
});

function httpConfig(overrides = {}) {
  return {
    fizzy: {
      bot_user_id: "",
      ...(overrides.fizzy ?? {})
    },
    server: {
      host: "127.0.0.1",
      port: "auto",
      port_allocation: "random",
      ...(overrides.server ?? {})
    },
    webhook: {
      enabled: true,
      path: "/webhook",
      secret: "",
      manage: false,
      ...(overrides.webhook ?? {})
    }
  };
}

function readyStatus() {
  return {
    health: () => ({ live: true, status: "live", ready: true }),
    ready: () => ({ ready: true, status: "ready", blockers: [] }),
    status: () => ({ schema_version: "fizzy-symphony-status-v1", runs: {} })
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null
  };
}

function signature(body, secret) {
  return createHmac("sha256", secret).update(body).digest("hex");
}
