import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

import { FizzySymphonyError } from "./errors.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_BASE_PORT = 4567;
const MAX_SCAN_ATTEMPTS = 100;
const DEFAULT_WEBHOOK_PATH = "/webhook";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export async function bindServerListener(serverConfig = {}, options = {}) {
  const host = serverConfig.host ?? DEFAULT_HOST;
  const plan = allocationPlan(serverConfig);
  const requestListener = options.requestListener ?? defaultRequestListener;
  const server = options.server ?? http.createServer(requestListener);
  const attempted = [];

  for (const port of plan.ports) {
    attempted.push(port);
    try {
      await listen(server, host, port);
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      const endpoint = {
        host,
        port: boundPort,
        base_url: `http://${host}:${boundPort}`
      };

      return {
        server,
        endpoint,
        attempted_ports: attempted,
        async close() {
          await closeServer(server);
        }
      };
    } catch (error) {
      if (plan.mode === "fixed" || !isAddressUnavailable(error)) {
        throw portUnavailable(error, host, port, attempted);
      }
    }
  }

  throw new FizzySymphonyError("PORT_UNAVAILABLE", "No available TCP port found for fizzy-symphony.", {
    host,
    port: attempted[0],
    attempted_ports: attempted
  });
}

function allocationPlan(serverConfig) {
  const allocation = serverConfig.port_allocation ?? (serverConfig.port === "auto" ? "next_available" : "fixed");

  if (allocation === "random") {
    return { mode: "random", ports: [0] };
  }

  if (allocation === "fixed") {
    return { mode: "fixed", ports: [Number(serverConfig.port)] };
  }

  const start = Number.isInteger(serverConfig.port) ? serverConfig.port : (serverConfig.base_port ?? DEFAULT_BASE_PORT);
  return {
    mode: "next_available",
    ports: Array.from({ length: Math.min(MAX_SCAN_ATTEMPTS, 65536 - start) }, (_, index) => start + index)
  };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startLocalHttpServer(deps = {}, options = {}) {
  const config = deps.config ?? {};
  const requestListener = createLocalHttpHandler(deps);
  return bindServerListener(config.server ?? {}, { ...options, requestListener });
}

export function createLocalHttpHandler(deps = {}) {
  const {
    config = {},
    status,
    enqueueWebhookHint = () => null,
    now = () => new Date(),
    logger,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    seenWebhookEventIds = new Set()
  } = deps;
  const webhookPath = normalizePath(config.webhook?.path ?? DEFAULT_WEBHOOK_PATH);

  return async function localHttpHandler(request, response) {
    try {
      const pathname = requestPathname(request);

      if (pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return writeJson(response, 200, callStatus(status, "health", { live: true, status: "live" }));
      }

      if (pathname === "/ready") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const readiness = callStatus(status, "ready", { ready: false, status: "not_ready", blockers: [] });
        return writeJson(response, readiness.ready ? 200 : 503, readiness);
      }

      if (pathname === "/status") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        return writeJson(response, 200, callStatus(status, "status", {}));
      }

      if (pathname === webhookPath) {
        if (config.webhook?.enabled === false) {
          return writeError(response, 404, "WEBHOOK_DISABLED", "Webhook intake is disabled.");
        }
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        return await handleWebhook(request, response, {
          config,
          enqueueWebhookHint,
          now,
          maxBodyBytes,
          seenWebhookEventIds
        });
      }

      return writeError(response, 404, "NOT_FOUND", "Route not found.");
    } catch (error) {
      logger?.error?.({ error }, "local HTTP handler failed");
      return writeError(response, 500, "HTTP_HANDLER_ERROR", "Local HTTP handler failed.");
    }
  };
}

export function createWebhookHintQueue(options = {}) {
  const limit = options.limit ?? 1000;
  const queue = [];

  return {
    enqueue: (hint = {}) => {
      const normalized = clone(hint);
      queue.push(normalized);
      while (queue.length > limit) queue.shift();
      return clone(normalized);
    },
    drain: () => queue.splice(0).map(clone),
    snapshot: () => queue.map(clone),
    get size() {
      return queue.length;
    }
  };
}

async function handleWebhook(request, response, options = {}) {
  const {
    config = {},
    enqueueWebhookHint,
    now,
    maxBodyBytes,
    seenWebhookEventIds
  } = options;
  let rawBody;

  try {
    rawBody = await readRawBody(request, { maxBodyBytes });
  } catch (error) {
    if (error.code === "WEBHOOK_BODY_TOO_LARGE") {
      return writeError(response, 413, error.code, "Webhook request body is too large.");
    }
    throw error;
  }

  const secret = config.webhook?.secret ? String(config.webhook.secret) : "";
  if (secret) {
    const supplied = request.headers["x-webhook-signature"];
    if (!supplied) {
      return writeError(response, 401, "WEBHOOK_SIGNATURE_REQUIRED", "Webhook signature is required.");
    }
    if (!verifyWebhookSignature(rawBody, supplied, secret)) {
      return writeError(response, 401, "WEBHOOK_SIGNATURE_INVALID", "Webhook signature is invalid.");
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return writeError(response, 400, "INVALID_WEBHOOK_PAYLOAD", "Webhook payload must be valid JSON.");
  }

  const hint = candidateHintFromWebhookEvent(event, { now });
  if (!hint.card_id) {
    return writeError(response, 400, "INVALID_WEBHOOK_PAYLOAD", "Webhook payload must identify a candidate card.");
  }

  if (hint.event_id && seenWebhookEventIds.has(hint.event_id)) {
    return writeJson(response, 200, {
      ok: true,
      status: "duplicate",
      hint: publicHint(hint),
      signature_verification: secret ? "enabled" : "disabled",
      webhook_management: config.webhook?.manage ? "managed" : "unmanaged"
    });
  }

  if (hint.event_id) seenWebhookEventIds.add(hint.event_id);
  await enqueueWebhookHint(hint);

  return writeJson(response, 202, {
    ok: true,
    status: "accepted",
    hint: publicHint(hint),
    signature_verification: secret ? "enabled" : "disabled",
    webhook_management: config.webhook?.manage ? "managed" : "unmanaged"
  });
}

function readRawBody(request, { maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        const error = new Error("Webhook request body is too large.");
        error.code = "WEBHOOK_BODY_TOO_LARGE";
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  const supplied = normalizeSignature(signatureHeader);
  if (!/^[a-f0-9]{64}$/iu.test(supplied)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const suppliedBytes = Buffer.from(supplied, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function normalizeSignature(signatureHeader) {
  const raw = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const value = String(raw ?? "").trim();
  return value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
}

function candidateHintFromWebhookEvent(event, { now = () => new Date() } = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return {};

  const card = event.card ?? event.data?.card ?? event.payload?.card ?? {};
  const board = event.board ?? event.data?.board ?? event.payload?.board ?? {};
  const cardId = event.card_id ?? event.cardId ?? card.id ?? card.card_id;
  const boardId = event.board_id ?? event.boardId ?? board.id ?? board.board_id ?? card.board_id ?? card.boardId;

  return omitUndefined({
    source: "webhook",
    event_id: event.event_id ?? event.eventId ?? event.id,
    card_id: cardId,
    board_id: boardId,
    received_at: toIso(typeof now === "function" ? now() : now)
  });
}

function publicHint(hint = {}) {
  return omitUndefined({
    event_id: hint.event_id,
    card_id: hint.card_id,
    board_id: hint.board_id
  });
}

function callStatus(status, method, fallback) {
  return typeof status?.[method] === "function" ? status[method]() : fallback;
}

function requestPathname(request) {
  return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
}

function normalizePath(path) {
  const value = String(path || DEFAULT_WEBHOOK_PATH);
  return value.startsWith("/") ? value : `/${value}`;
}

function methodNotAllowed(response, allowed) {
  return writeError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed.", {}, {
    allow: allowed.join(", ")
  });
}

function writeError(response, statusCode, code, message, details = {}, headers = {}) {
  return writeJson(response, statusCode, { ok: false, error: { code, message, details } }, headers);
}

function writeJson(response, statusCode, body, headers = {}) {
  if (response.headersSent) return;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function omitUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isAddressUnavailable(error) {
  return error?.code === "EADDRINUSE" || error?.code === "EACCES";
}

function portUnavailable(error, host, port, attempted_ports) {
  return new FizzySymphonyError("PORT_UNAVAILABLE", `Unable to bind ${host}:${port}.`, {
    host,
    port,
    attempted_ports,
    cause: { code: error?.code, message: error?.message }
  });
}

function defaultRequestListener(_request, response) {
  response.statusCode = 404;
  response.end("not found\n");
}
