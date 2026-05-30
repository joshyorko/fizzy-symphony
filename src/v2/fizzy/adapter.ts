// SDK / HTTP boundary for the FizzyPort.
//
// The point of this file is the boundary, not the implementation. The daemon
// and cockpit depend on FizzyPort (in core/types.ts), never on the Fizzy SDK
// types. Three implementations are anticipated:
//
//   1. SDK adapter   — wraps @37signals/fizzy when it cleanly supports an op.
//   2. HTTP adapter  — direct HTTP/OpenAPI where the SDK lacks an op.
//   3. Fake          — fixture-backed, see ./fake.ts (used by tests).
//
// For the spike the SDK/HTTP adapters are deliberately left as a typed factory
// that reports its mode and throws a clear "not wired in spike" error if an op
// is called. v1 already ships a working SDK-backed client (src/fizzy-client.js
// + src/fizzy-sdk-adapter.js); production v2 would delegate to it here.

import type { FizzyPort } from "../core/types.ts";

export type FizzyAdapterMode = "sdk" | "http";

export interface FizzyAdapterOptions {
  mode?: FizzyAdapterMode;
  apiUrl?: string;
  token?: string;
  account?: string;
}

function notWired(operation: string, mode: FizzyAdapterMode): never {
  const error = new Error(
    `FizzyPort.${operation} is not wired in the v2 spike (${mode} mode). ` +
      `Delegate to v1 src/fizzy-client.js or implement the ${mode} call here.`
  );
  (error as { code?: string }).code = "FIZZY_ADAPTER_NOT_WIRED";
  throw error;
}

// Returns a FizzyPort whose read/write ops are intentionally unimplemented for
// the spike. describe() advertises the chosen boundary so the cockpit can show
// "moveCard adapter unavailable" rather than silently failing.
export function createFizzyAdapter(options: FizzyAdapterOptions = {}): FizzyPort {
  const mode: FizzyAdapterMode = options.mode ?? "sdk";
  const note =
    mode === "sdk"
      ? "v2 spike: delegate to @37signals/fizzy via v1 adapter"
      : "v2 spike: direct HTTP/OpenAPI adapter";

  return {
    describe() {
      return { kind: `fizzy-${mode}`, sdk: mode === "sdk", note };
    },
    listBoards: async () => notWired("listBoards", mode),
    getBoard: async () => notWired("getBoard", mode),
    listCards: async () => notWired("listCards", mode),
    getCard: async () => notWired("getCard", mode),
    listComments: async () => notWired("listComments", mode),
    createComment: async () => notWired("createComment", mode),
    updateComment: async () => notWired("updateComment", mode),
    moveCard: async () => notWired("moveCard", mode)
  };
}
