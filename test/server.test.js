import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { createLocalHttpHandler, createWebhookHintQueue } from "../src/server.js";
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

test("webhook verifies signatures, dedupes event IDs, and enqueues candidate hints only", async () => {
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
      action: "card.updated",
      card: { id: "card_1", board_id: "board_1" }
    });
    const accepted = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature(body, config.webhook.secret)
      },
      body
    });

    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.body.status, "accepted");
    assert.deepEqual(accepted.body.hint, {
      event_id: "event_1",
      action: "card_updated",
      intent: "candidate_changed",
      card_id: "card_1",
      board_id: "board_1"
    });
    assert.deepEqual(queue.snapshot(), [{
      source: "webhook",
      event_id: "event_1",
      action: "card_updated",
      intent: "candidate_changed",
      card_id: "card_1",
      board_id: "board_1",
      received_at: "2026-04-29T12:00:00.000Z"
    }]);

    const duplicate = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature(body, config.webhook.secret)
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

test("webhook ignores self-authored daemon comments unless rerun is explicit", async () => {
  const config = httpConfig({
    fizzy: { bot_user_id: "bot_1" },
    webhook: { enabled: true, path: "/webhook" }
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
    const ignored = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "event_self",
        action: "comment_created",
        comment: { body: "fizzy-symphony status update", author: { id: "bot_1" } },
        card: { id: "card_1", board_id: "board_1" }
      })
    });

    assert.equal(ignored.response.status, 200);
    assert.equal(ignored.body.status, "ignored");
    assert.equal(ignored.body.reason, "self_authored_daemon_comment");
    assert.equal(queue.size, 0);

    const rerun = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "event_self_rerun",
        action: "comment_created",
        comment: { body: "agent-rerun", author: { id: "bot_1" } },
        card: { id: "card_1", board_id: "board_1", tags: ["agent-rerun"] }
      })
    });

    assert.equal(rerun.response.status, 202);
    assert.equal(rerun.body.status, "accepted");
    assert.deepEqual(queue.snapshot(), [{
      source: "webhook",
      event_id: "event_self_rerun",
      action: "comment_created",
      intent: "candidate_changed",
      card_id: "card_1",
      board_id: "board_1",
      rerun_requested: true,
      received_at: "2026-04-29T12:00:00.000Z"
    }]);
  } finally {
    await server.close();
  }
});

test("webhook maps lifecycle actions to cancellation and golden-ticket refresh hints", async () => {
  const config = httpConfig();
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

    const golden = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "event_golden",
        action: "comment_created",
        card: { id: "golden_1", board_id: "board_1", golden: true, tags: ["agent-instructions"] }
      })
    });
    assert.equal(golden.response.status, 202);

    assert.deepEqual(queue.snapshot(), [
      {
        source: "webhook",
        event_id: "event_closed",
        action: "card_closed",
        intent: "cancel_active",
        cancel_reason: "card_closed",
        card_id: "card_1",
        board_id: "board_1",
        received_at: "2026-04-29T12:00:00.000Z"
      },
      {
        source: "webhook",
        event_id: "event_golden",
        action: "comment_created",
        intent: "refresh_routes",
        card_id: "golden_1",
        board_id: "board_1",
        received_at: "2026-04-29T12:00:00.000Z"
      }
    ]);
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
      enqueueWebhookHint: (hint) => hints.push(hint)
    })
  });

  try {
    const missingSignature = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_id: "event_1", card_id: "card_1" })
    });
    assert.equal(missingSignature.response.status, 401);
    assert.equal(missingSignature.body.error.code, "WEBHOOK_SIGNATURE_REQUIRED");

    const invalidJson = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature("{not json", config.webhook.secret)
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
