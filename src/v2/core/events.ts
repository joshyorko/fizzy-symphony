// Local runtime event log.
//
// For the spike this is an in-memory append-only log that can optionally
// serialize to JSONL. No database. Events are plain data; the cockpit renders
// recent events but never writes them during render.

import { randomUUID } from "node:crypto";

import type { RuntimeEvent, WarningSeverity } from "./types.ts";

export interface EventLogOptions {
  limit?: number;
  now?: () => Date;
}

export interface AppendEventInput {
  type: string;
  severity?: WarningSeverity;
  message: string;
  boardId?: string;
  cardId?: string;
  cardNumber?: number | string;
  runId?: string;
  sessionId?: string;
  workspacePath?: string;
  data?: unknown;
}

export interface EventLog {
  append(input: AppendEventInput): RuntimeEvent;
  recent(count?: number): RuntimeEvent[];
  all(): RuntimeEvent[];
  toJsonl(): string;
}

export function createEventLog(options: EventLogOptions = {}): EventLog {
  const limit = options.limit ?? 200;
  const now = options.now ?? (() => new Date());
  const events: RuntimeEvent[] = [];

  function append(input: AppendEventInput): RuntimeEvent {
    const event: RuntimeEvent = {
      id: randomUUID(),
      type: input.type,
      severity: input.severity ?? "info",
      message: input.message,
      at: now().toISOString(),
      boardId: input.boardId,
      cardId: input.cardId,
      cardNumber: input.cardNumber,
      runId: input.runId,
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      data: input.data
    };
    events.push(event);
    if (events.length > limit) {
      events.splice(0, events.length - limit);
    }
    return event;
  }

  function recent(count = 20): RuntimeEvent[] {
    return events.slice(-count).reverse();
  }

  function all(): RuntimeEvent[] {
    return [...events];
  }

  function toJsonl(): string {
    return events.map((event) => JSON.stringify(event)).join("\n");
  }

  return { append, recent, all, toJsonl };
}

export function parseJsonlEvents(text: string): RuntimeEvent[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeEvent);
}
