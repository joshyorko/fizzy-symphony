import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 250;
const DEFAULT_TERM_TIMEOUT_MS = 5000;
const DEFAULT_KILL_TIMEOUT_MS = 2000;

export function launchCodexAppServerTransport(options = {}) {
  const {
    command = "codex",
    args = ["app-server"],
    cwd = process.cwd(),
    env = process.env,
    spawn = nodeSpawn,
    maxStderrBytes = DEFAULT_MAX_STDERR_BYTES
  } = options;

  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });

  return new CodexAppServerTransport(child, { maxStderrBytes });
}

export class CodexAppServerTransport {
  constructor(child, options = {}) {
    this.child = child;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new EventEmitter();
    this.buffer = "";
    this.stderr = "";
    this.exited = false;

    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => this.receiveStdout(chunk));
    child.stderr?.on?.("data", (chunk) => this.receiveStderr(chunk));
    child.once?.("exit", (code, signal) => this.handleExit(code, signal));
    child.once?.("error", (error) => this.handleChildError(error));
  }

  request(method, params, options = {}) {
    if (this.exited) {
      return Promise.reject(appServerError("APP_SERVER_EXITED", "Codex app-server process has exited.", {
        stderr: this.stderr
      }));
    }

    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };

    return new Promise((resolve, reject) => {
      let timeout;
      const timeoutMs = Number(options.timeoutMs);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(appServerError("APP_SERVER_REQUEST_TIMEOUT", `Codex app-server request timed out: ${method}.`, {
            method,
            timeout_ms: timeoutMs
          }));
        }, timeoutMs);
      }

      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.writeMessage(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  onNotification(handler) {
    this.events.on("notification", handler);
    return () => this.events.off("notification", handler);
  }

  onServerRequest(handler) {
    this.events.on("serverRequest", handler);
    return () => this.events.off("serverRequest", handler);
  }

  onExit(handler) {
    this.events.on("exit", handler);
    return () => this.events.off("exit", handler);
  }

  onProtocolError(handler) {
    this.events.on("protocolError", handler);
    return () => this.events.off("protocolError", handler);
  }

  respond(id, result) {
    this.writeMessage({ id, result });
  }

  respondError(id, error) {
    this.writeMessage({
      id,
      error: {
        code: error?.code ?? "APP_SERVER_CLIENT_ERROR",
        message: error?.message ?? String(error ?? "Codex app-server client error."),
        data: error?.details
      }
    });
  }

  async close(options = {}) {
    if (this.exited) return { status: "closed" };
    this.child.stdin?.end?.();
    this.child.kill?.(options.signal ?? "SIGTERM");
    await delay(options.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
    return { status: this.exited ? "closed" : "closing" };
  }

  async terminate(options = {}) {
    const termTimeoutMs = options.termTimeoutMs ?? DEFAULT_TERM_TIMEOUT_MS;
    const killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;

    if (this.exited) return { status: "terminated", already_exited: true };

    this.child.kill?.("SIGTERM");
    if (await this.waitForExit(termTimeoutMs)) {
      return { status: "terminated", signal: "SIGTERM" };
    }

    this.child.kill?.("SIGKILL");
    if (await this.waitForExit(killTimeoutMs)) {
      return { status: "terminated", signal: "SIGKILL" };
    }

    return { status: "failed", signal: "SIGKILL", error: { code: "APP_SERVER_KILL_TIMEOUT" } };
  }

  receiveStdout(chunk) {
    this.buffer += String(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  receiveStderr(chunk) {
    this.stderr = `${this.stderr}${String(chunk)}`;
    if (this.stderr.length > this.maxStderrBytes) {
      this.stderr = this.stderr.slice(this.stderr.length - this.maxStderrBytes);
    }
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      const protocolError = appServerError(
        "APP_SERVER_MALFORMED_MESSAGE",
        `Malformed Codex app-server JSONL message: ${error.message}`,
        { line }
      );
      this.rejectAll(protocolError);
      this.events.emit("protocolError", protocolError);
      return;
    }

    if (message && Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      this.handleResponse(message);
      return;
    }

    if (message && Object.hasOwn(message, "id") && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message?.method) {
      this.events.emit("notification", message);
      return;
    }

    const protocolError = appServerError("APP_SERVER_UNKNOWN_MESSAGE", "Unknown Codex app-server protocol message.", {
      message
    });
    this.rejectAll(protocolError);
    this.events.emit("protocolError", protocolError);
  }

  handleResponse(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);

    if (Object.hasOwn(message, "error")) {
      pending.reject(appServerError(
        message.error?.code ?? "APP_SERVER_PROTOCOL_ERROR",
        message.error?.message ?? `Codex app-server request failed: ${pending.method}.`,
        { method: pending.method, error: message.error }
      ));
      return;
    }

    pending.resolve(message.result);
  }

  handleServerRequest(message) {
    const handlers = this.events.listeners("serverRequest");
    if (handlers.length === 0) {
      this.respondError(message.id, appServerError("APP_SERVER_UNHANDLED_REQUEST", "Unhandled Codex app-server server request.", {
        method: message.method
      }));
      return;
    }

    for (const handler of handlers) {
      try {
        const result = handler(message);
        if (result?.then) {
          result
            .then((resolved) => {
              if (resolved !== undefined) this.respond(message.id, resolved);
            })
            .catch((error) => this.respondError(message.id, error));
        } else if (result !== undefined) {
          this.respond(message.id, result);
        }
      } catch (error) {
        this.respondError(message.id, error);
      }
    }
  }

  handleExit(code, signal) {
    this.exited = true;
    const error = appServerError(
      "APP_SERVER_EXITED",
      `Codex app-server exited${code === null ? "" : ` with code ${code}`}${signal ? ` from ${signal}` : ""}.${this.stderr ? ` stderr: ${this.stderr}` : ""}`,
      { code, signal, stderr: this.stderr }
    );
    this.rejectAll(error);
    this.events.emit("exit", { code, signal, stderr: this.stderr });
  }

  handleChildError(error) {
    const wrapped = appServerError(error.code ?? "APP_SERVER_PROCESS_ERROR", error.message, {
      cause: error.message,
      stderr: this.stderr
    });
    this.rejectAll(wrapped);
    this.events.emit("protocolError", wrapped);
  }

  writeMessage(message) {
    if (!this.child.stdin?.write) {
      throw appServerError("APP_SERVER_STDIN_UNAVAILABLE", "Codex app-server stdin is unavailable.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  waitForExit(timeoutMs) {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.events.off("exit", onExit);
      };
      this.events.on("exit", onExit);
    });
  }
}

function appServerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
