import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

import {
  bindServerListener,
  createLocalHttpHandler as createListenerLocalHttpHandler,
  createWebhookHintQueue,
  startLocalHttpServer
} from "../src/listener.js";
import {
  createLocalHttpHandler as createServerLocalHttpHandler,
  createWebhookHintQueue as createServerWebhookHintQueue
} from "../src/server.js";
import { startLocalInstance } from "../src/instance-registry.js";
import { coordinationConfig, tempProject } from "./helpers.js";

test("fixed port collision fails before writing an instance registry file", async () => {
  const root = await tempProject("fizzy-symphony-fixed-collision-");
  const busy = await reservePortWithFreeNext();
  const config = coordinationConfig(root, {
    instance: { id: "fixed-instance" },
    server: {
      port: busy.port,
      port_allocation: "fixed",
      base_port: busy.port,
      registry_dir: join(root, "instances")
    }
  });

  try {
    await assert.rejects(
      () => startLocalInstance(config, { configPath: join(root, "config.json") }),
      (error) => error.code === "PORT_UNAVAILABLE" && error.details.port === busy.port
    );

    await assert.rejects(() => readdir(config.server.registry_dir), { code: "ENOENT" });
  } finally {
    await closeServer(busy.server);
  }
});

test("next_available scans from the configured base port and holds listener ownership", async () => {
  const root = await tempProject("fizzy-symphony-next-port-");
  const busy = await reservePortWithFreeNext();
  const config = coordinationConfig(root, {
    instance: { id: "next-instance" },
    server: {
      port: busy.port,
      port_allocation: "next_available",
      base_port: busy.port,
      registry_dir: join(root, "instances")
    }
  });

  let instance;
  try {
    instance = await startLocalInstance(config, { configPath: join(root, "config.json") });

    assert.equal(instance.endpoint.host, "127.0.0.1");
    assert.equal(instance.endpoint.port, busy.port + 1);
    await assertPortBusy(instance.endpoint.host, instance.endpoint.port);

    const registry = JSON.parse(await readFile(instance.registryPath, "utf8"));
    assert.equal(registry.instance_id, "next-instance");
    assert.equal(registry.port, busy.port + 1);
    assert.equal(registry.base_url, `http://127.0.0.1:${busy.port + 1}`);
  } finally {
    await instance?.cleanup();
    await closeServer(busy.server);
  }
});

test("random port allocation binds port zero and records the actual bound port", async () => {
  const root = await mkdtemp(join(tmpdir(), "fizzy-symphony-random-port-"));
  const config = coordinationConfig(root, {
    instance: { id: "random-instance" },
    server: {
      port: "auto",
      port_allocation: "random",
      registry_dir: join(root, "instances")
    }
  });

  const instance = await startLocalInstance(config, { configPath: join(root, "config.json") });
  try {
    assert.equal(instance.endpoint.host, "127.0.0.1");
    assert.ok(Number.isInteger(instance.endpoint.port));
    assert.ok(instance.endpoint.port > 0);

    const registry = JSON.parse(await readFile(instance.registryPath, "utf8"));
    assert.equal(registry.port, instance.endpoint.port);
    assert.equal(registry.base_url, `http://127.0.0.1:${instance.endpoint.port}`);
  } finally {
    await instance.cleanup();
  }
});

test("bindServerListener supports direct fixed bind-and-hold without registry side effects", async () => {
  const holder = await bindServerListener({
    host: "127.0.0.1",
    port: "auto",
    port_allocation: "random"
  });

  try {
    await assertPortBusy(holder.endpoint.host, holder.endpoint.port);
  } finally {
    await holder.close();
  }
});

test("listener exports delegate HTTP semantics to the production server module", () => {
  assert.equal(createListenerLocalHttpHandler, createServerLocalHttpHandler);
  assert.equal(createWebhookHintQueue, createServerWebhookHintQueue);
});

test("local HTTP server serves health, readiness, and live status JSON", async () => {
  const liveSnapshot = {
    schema_version: "fizzy-symphony-status-v1",
    instance: { id: "instance-http" },
    webhook: { enabled: true, management: { status: "unmanaged" } }
  };
  const server = await startLocalHttpServer({
    config: httpConfig(),
    status: {
      health: () => ({ live: true, status: "live", ready: false }),
      ready: () => ({
        ready: false,
        status: "not_ready",
        blockers: [{ code: "RUNNER_NOT_READY", message: "Runner is unavailable." }]
      }),
      status: () => liveSnapshot
    }
  });

  try {
    const health = await fetchJson(`${server.endpoint.base_url}/health`);
    assert.equal(health.response.status, 200);
    assert.deepEqual(health.body, { live: true, status: "live", ready: false });

    const ready = await fetchJson(`${server.endpoint.base_url}/ready`);
    assert.equal(ready.response.status, 503);
    assert.equal(ready.body.ready, false);
    assert.equal(ready.body.blockers[0].code, "RUNNER_NOT_READY");

    liveSnapshot.poll = { tick_in_progress: true };
    const status = await fetchJson(`${server.endpoint.base_url}/status`);
    assert.equal(status.response.status, 200);
    assert.deepEqual(status.body, liveSnapshot);
  } finally {
    await server.close();
  }
});

test("local HTTP server returns JSON errors for unknown routes and unsupported methods", async () => {
  const server = await startLocalHttpServer({
    config: httpConfig(),
    status: readyStatus()
  });

  try {
    const unknown = await fetchJson(`${server.endpoint.base_url}/nope`);
    assert.equal(unknown.response.status, 404);
    assert.equal(unknown.body.error.code, "NOT_FOUND");

    const wrongMethod = await fetchJson(`${server.endpoint.base_url}/health`, { method: "POST" });
    assert.equal(wrongMethod.response.status, 405);
    assert.equal(wrongMethod.response.headers.get("allow"), "GET");
    assert.equal(wrongMethod.body.error.code, "METHOD_NOT_ALLOWED");

    const webhookWrongMethod = await fetchJson(`${server.endpoint.base_url}/webhook`, { method: "GET" });
    assert.equal(webhookWrongMethod.response.status, 405);
    assert.equal(webhookWrongMethod.response.headers.get("allow"), "POST");
    assert.equal(webhookWrongMethod.body.error.code, "METHOD_NOT_ALLOWED");
  } finally {
    await server.close();
  }
});

test("webhook accepts a valid signature and enqueues a candidate hint only", async () => {
  const hints = [];
  const config = httpConfig({
    webhook: { enabled: true, path: "/webhook", secret: "webhook-secret", manage: false }
  });
  const server = await startLocalHttpServer({
    config,
    status: readyStatus(),
    now: () => new Date("2026-04-29T12:00:00.000Z"),
    enqueueWebhookHint: (hint) => {
      hints.push(hint);
      return hint;
    }
  });

  try {
    const body = JSON.stringify({
      id: "event_1",
      action: "card_triaged",
      card: { id: "card_1", board_id: "board_1", title: "Implement server" }
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
    assert.equal(accepted.body.signature_verification, "enabled");
    assert.deepEqual(accepted.body.hint, {
      intent: "spawn",
      reason: "card_triaged",
      event_id: "event_1",
      action: "card_triaged",
      card_id: "card_1",
      board_id: "board_1"
    });
    assert.deepEqual(hints, [{
      source: "webhook",
      intent: "spawn",
      reason: "card_triaged",
      event_id: "event_1",
      action: "card_triaged",
      card_id: "card_1",
      board_id: "board_1",
      received_at: "2026-04-29T12:00:00.000Z"
    }]);
    assert.equal(Object.hasOwn(hints[0], "event"), false);
    assert.equal(hints[0].action, "card_triaged");
  } finally {
    await server.close();
  }
});

test("webhook rejects missing or invalid signatures when a secret is configured", async () => {
  const hints = [];
  const config = httpConfig({
    webhook: { enabled: true, path: "/webhook", secret: "webhook-secret", manage: false }
  });
  const server = await startLocalHttpServer({
    config,
    status: readyStatus(),
    enqueueWebhookHint: (hint) => hints.push(hint)
  });

  try {
    const body = JSON.stringify({ id: "event_1", action: "card_triaged", card_id: "card_1", board_id: "board_1" });

    const missing = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    assert.equal(missing.response.status, 401);
    assert.equal(missing.body.error.code, "WEBHOOK_SIGNATURE_REQUIRED");

    const invalid = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": "not-a-valid-signature",
        "x-webhook-timestamp": "2026-04-29T12:00:00.000Z"
      },
      body
    });
    assert.equal(invalid.response.status, 401);
    assert.equal(invalid.body.error.code, "WEBHOOK_SIGNATURE_INVALID");
    assert.deepEqual(hints, []);
  } finally {
    await server.close();
  }
});

test("webhook accepts valid JSON without a signature when no secret is configured", async () => {
  const queue = createWebhookHintQueue();
  const config = httpConfig({
    webhook: { enabled: true, path: "/custom-webhook", secret: "", manage: false }
  });
  const server = await startLocalHttpServer({
    config,
    status: readyStatus(),
    now: () => new Date("2026-04-29T12:05:00.000Z"),
    enqueueWebhookHint: queue.enqueue
  });

  try {
    const accepted = await fetchJson(`${server.endpoint.base_url}/custom-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_id: "event_2", action: "card_triaged", card_id: "card_2", board_id: "board_1" })
    });

    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.body.signature_verification, "disabled");
    assert.deepEqual(queue.drain(), [{
      source: "webhook",
      intent: "spawn",
      reason: "card_triaged",
      event_id: "event_2",
      action: "card_triaged",
      card_id: "card_2",
      board_id: "board_1",
      received_at: "2026-04-29T12:05:00.000Z"
    }]);
    assert.equal(queue.size, 0);
  } finally {
    await server.close();
  }
});

test("webhook rejects malformed JSON without enqueueing a hint", async () => {
  const hints = [];
  const server = await startLocalHttpServer({
    config: httpConfig({ webhook: { enabled: true, path: "/webhook", secret: "", manage: false } }),
    status: readyStatus(),
    enqueueWebhookHint: (hint) => hints.push(hint)
  });

  try {
    const malformed = await fetchJson(`${server.endpoint.base_url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });

    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.error.code, "INVALID_WEBHOOK_PAYLOAD");
    assert.deepEqual(hints, []);
  } finally {
    await server.close();
  }
});

test("webhook intake disabled returns a clear error while unmanaged intake can still accept hooks", async () => {
  const disabled = await startLocalHttpServer({
    config: httpConfig({ webhook: { enabled: false, path: "/webhook", manage: false } }),
    status: readyStatus()
  });

  try {
    const rejected = await fetchJson(`${disabled.endpoint.base_url}/webhook`, {
      method: "POST",
      body: JSON.stringify({ id: "event_disabled", card_id: "card_1" })
    });
    assert.equal(rejected.response.status, 404);
    assert.equal(rejected.body.error.code, "WEBHOOK_DISABLED");
  } finally {
    await disabled.close();
  }

  const hints = [];
  const unmanaged = await startLocalHttpServer({
    config: httpConfig({ webhook: { enabled: true, path: "/webhook", secret: "", manage: false } }),
    status: readyStatus(),
    enqueueWebhookHint: (hint) => hints.push(hint)
  });

  try {
    const accepted = await fetchJson(`${unmanaged.endpoint.base_url}/webhook`, {
      method: "POST",
      body: JSON.stringify({ id: "event_unmanaged", action: "card_triaged", card_id: "card_1", board_id: "board_1" })
    });
    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.body.webhook_management, "unmanaged");
    assert.equal(hints.length, 1);
  } finally {
    await unmanaged.close();
  }
});

async function reservePortWithFreeNext() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const server = await listenOn(0);
    const port = server.address().port;
    if (port >= 65535) {
      await closeServer(server);
      continue;
    }

    if (await canBind(port + 1)) {
      return { server, port };
    }
    await closeServer(server);
  }
  throw new Error("Unable to reserve a test port with an available next port.");
}

async function assertPortBusy(host, port) {
  await assert.rejects(() => listenOn(port, host), (error) => error.code === "EADDRINUSE");
}

async function canBind(port, host = "127.0.0.1") {
  try {
    const server = await listenOn(port, host);
    await closeServer(server);
    return true;
  } catch {
    return false;
  }
}

function listenOn(port, host = "127.0.0.1") {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function httpConfig(overrides = {}) {
  return {
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
    status: () => ({
      schema_version: "fizzy-symphony-status-v1",
      readiness: { ready: true, status: "ready", blockers: [] }
    })
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
