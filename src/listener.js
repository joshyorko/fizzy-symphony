import http from "node:http";

import { FizzySymphonyError } from "./errors.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_BASE_PORT = 4567;
const MAX_SCAN_ATTEMPTS = 100;

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

