// v2 local API skeleton.
//
// Read-only endpoints serve the fixture-backed runtime. The single command
// endpoint validates, reports disabled/unavailable when not implemented, and
// writes an audit event when accepted. No database, no auth layer in the spike.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { SymphonyRuntime } from "./runtime.ts";

export interface ApiHandlerResult {
  statusCode: number;
  body: unknown;
}

// Pure request router: maps (method, path, parsed body) -> result. Exported so
// tests can exercise routing without binding a socket.
export function handleApiRequest(
  runtime: SymphonyRuntime,
  method: string,
  pathname: string,
  body?: unknown
): ApiHandlerResult {
  const status = runtime.getStatus();

  if (method === "GET") {
    switch (pathname) {
      case "/v2/health":
        return {
          statusCode: 200,
          body: {
            live: true,
            instanceId: status.instance.id,
            readiness: status.readiness.state
          }
        };
      case "/v2/ready":
        return {
          statusCode: status.readiness.ready ? 200 : 503,
          body: {
            ready: status.readiness.ready,
            state: status.readiness.state,
            blockers: status.readiness.blockers
          }
        };
      case "/v2/status":
        return { statusCode: 200, body: status };
      case "/v2/capabilities":
        return { statusCode: 200, body: { capabilities: runtime.getCapabilities() } };
      case "/v2/events":
        return { statusCode: 200, body: { events: runtime.getEvents(50) } };
      case "/v2/runs":
        return { statusCode: 200, body: { runs: status.runs } };
      case "/v2/worktrees":
        return { statusCode: 200, body: { worktrees: runtime.getWorktrees() } };
      default:
        break;
    }

    const runMatch = pathname.match(/^\/v2\/runs\/([^/]+)$/);
    if (runMatch) {
      const run = runtime.getRun(decodeURIComponent(runMatch[1]));
      if (!run) return { statusCode: 404, body: { error: "RUN_NOT_FOUND", runId: runMatch[1] } };
      return { statusCode: 200, body: { run } };
    }

    return { statusCode: 404, body: { error: "NOT_FOUND", path: pathname } };
  }

  if (method === "POST" && pathname === "/v2/commands") {
    const result = runtime.submitCommand(body);
    return { statusCode: commandHttpStatus(result), body: result };
  }

  return { statusCode: 404, body: { error: "NOT_FOUND", path: pathname, method } };
}

// Map a command outcome to its HTTP status code.
export function commandHttpStatus(result: { outcome: string }): number {
  if (result.outcome === "accepted" || result.outcome === "dry-run") return 202;
  if (result.outcome === "unavailable") return 409;
  return 400;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  return JSON.parse(text);
}

export interface ApiServerOptions {
  host?: string;
  port?: number;
}

export interface ApiServer {
  server: Server;
  listen(): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
}

export function createApiServer(runtime: SymphonyRuntime, options: ApiServerOptions = {}): ApiServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    let result: ApiHandlerResult;
    try {
      const body = method === "POST" ? await readJsonBody(req) : undefined;
      if (method === "POST" && url.pathname === "/v2/commands") {
        // The live server awaits port side effects (cancel/stop) via the async
        // command path; the pure router stays model-only for deterministic tests.
        const commandResult = await runtime.submitCommandAsync(body);
        result = { statusCode: commandHttpStatus(commandResult), body: commandResult };
      } else {
        result = handleApiRequest(runtime, method, url.pathname, body);
      }
    } catch (error) {
      result = { statusCode: 400, body: { error: "BAD_REQUEST", message: (error as Error).message } };
    }
    const payload = `${JSON.stringify(result.body)}\n`;
    res.writeHead(result.statusCode, { "content-type": "application/json" });
    res.end(payload);
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          const boundPort = typeof address === "object" && address ? address.port : port;
          resolve({ host, port: boundPort, url: `http://${host}:${boundPort}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
