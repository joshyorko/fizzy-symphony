# v2 Cockpit Runtime Spike — Decisions & Assumptions

> Scope: this document records the reasonable assumptions made while building the
> v2 cockpit runtime spike. The brief was "do not ask for clarification; make
> reasonable assumptions and document them here." Everything below is a spike-level
> decision, reversible, and deliberately narrow.

## 1. Language & runtime: TypeScript via Node native type stripping

- **Decision:** The v2 core is written in `.ts` and executed directly by Node
  (v26) using native type stripping. There is **no build pipeline, no `tsc`, no
  bundler**.
- **Why:** The brief asked for a TypeScript core. The repo already runs on Node
  >= 25 with ESM. Node 26 strips types from `.ts` on import, and `.js` test files
  can import `.ts` modules with no extra tooling. This keeps the spike a single
  `node --test` run, identical to v1, while still giving us typed contracts.
- **Constraint accepted:** Type stripping only supports *erasable* syntax —
  interfaces, type aliases, and `as` casts. **No `enum`, no `namespace`, no
  parameter properties.** All v2 code obeys this.
- **Imports must carry the `.ts` extension** (ESM resolution), e.g.
  `import { createRuntime } from "./daemon/runtime.ts"`.

## 2. Layout: `src/v2/` (not a separate package)

- **Decision:** All spike code lives under `src/v2/` with subfolders
  `core/`, `fizzy/`, `codex/`, `daemon/`, `cockpit/`, `cli/`, plus a barrel
  `src/v2/index.ts`. Fixtures live in `test/fixtures/v2/`, tests in `test/v2/`.
- **Why:** A `packages/` monorepo split was considered but rejected as too
  disruptive for a spike. `src/v2/` is additive, leaves all of v1 untouched, and
  is trivial to delete or promote later.
- **No v1 deletion.** Not one v1 file was removed. The only v1 edit is additive
  wiring in `bin/fizzy-symphony.js` (two new command branches) and the
  `package.json` test script (so `test/v2/*.test.js` also runs).

## 3. Tests are `.js`, source is `.ts`

- **Decision:** Test files keep the `*.test.js` extension and import the `.ts`
  modules under test.
- **Why:** The existing runner globs `test/*.test.js`. Keeping the extension means
  the v2 tests slot into the same harness with no new toolchain. Verified that a
  `.js` test can import and exercise a `.ts` module under Node 26.

## 4. Commands are dry-run by default

- **Decision:** `createRuntime` accepts `applyCommands` (default **`false`**).
  With the default, every operator command is **validated**, **availability-checked**,
  and then **recorded as a dry-run event** (`command.dry-run.<type>`) with outcome
  `"dry-run"`. No state changes.
- **With `applyCommands: true`** (CLI `--apply`), the same validated command is run
  through the pure reducer `applyCommandToStatus`
  ([src/v2/daemon/apply-command.ts](../../src/v2/daemon/apply-command.ts)), which
  mutates the **in-memory `SymphonyStatus` model** (pause/resume, run cancel,
  session stop, card rerun/move, worktree preserve/cleanup) and emits a
  `command.accepted.<type>` event. Capabilities re-derive from the new state.
  Live FizzyPort and CodexRunnerPort side-effects are dispatched only from the
  async runtime path; the reducer remains the deterministic model layer those
  adapters sit beneath.
- **Why:** The brief forbids fake controls. A button that *pretends* to cancel a
  run is a fake control. The v2 runtime therefore has two explicit modes:
  dry-run records the validated operator intent, while `applyCommands` dispatches
  through wired ports and records the real effect events.
- **Single choke point:** `runtime.submitCommand` is the *only* place a command is
  evaluated synchronously; `runtime.submitCommandAsync` is the only path that
  dispatches live port side-effects. Render and model code never mutate state.

## 5. Fizzy and Codex adapters sit behind ports

- **Decision:** `createFizzyAdapter` delegates to the existing v1 Fizzy client,
  `createCodexAdapter({ mode: "sdk" })` delegates to `@openai/codex-sdk`, and
  `createCodexAdapter({ mode: "cli-app-server" })` delegates to the existing v1
  Codex CLI app-server runner.
- **Why:** The v2 core still depends only on `FizzyPort` and `CodexRunnerPort`,
  while the daemon can now drive real board comments/moves, native SDK
  threads/turns, and app-server session/turn/cancel/stop calls. The fakes
  (`createFakeFizzyPort`, `createFakeCodexRunner`) remain deterministic
  fixture-backed implementations for tests and isolated cockpit models.
- **FizzyPort is independent of the SDK.** The port types are hand-written in
  `core/types.ts` and do not import or re-export `@37signals/fizzy` types. The SDK
  is one possible adapter `mode`, not the contract.
- **CodexRunnerPort is SDK-compatible.** Its method set
  (`detect/health/startSession/startTurn/streamTurn/cancelTurn/stopSession/terminateOwnedProcess`)
  mirrors the Codex app-server/SDK lifecycle. Both SDK and app-server modes are
  live adapters behind the same port contract.

## 6. Default cockpit fixture

- **Decision:** `fizzy-symphony cockpit` with no source flags loads
  `src/v2/fixtures/ready.json`.
- **Why:** A spike needs a zero-arg happy path for demos, and the default fixture
  must be present after npm/Homebrew packaging. Test fixtures remain under
  `test/fixtures/v2/`.

## 7. Non-TTY behavior preserved

- **Decision:** In a non-TTY stream (or with `--once`), the cockpit prints a single
  static text frame to stdout and a short note to stderr; it never tries to grab
  the terminal. `--json` emits machine-readable model/capability output.
- **Why:** v1 already supports non-interactive status. The spike must not regress
  pipelines or CI.

## 8. Terminal Kit imported lazily

- **Decision:** `terminal-kit` is imported dynamically, only inside the interactive
  renderer, behind a `terminalFactory` seam.
- **Why:** It is a CJS dependency; lazy import keeps v1 startup and all non-TTY /
  test paths free of it, and lets tests inject a fake terminal.

## 9. Live daemon bridge

- **Decision:** The existing daemon now serves `/v2/*` from the same local HTTP
  listener as `/status`, projecting the v1 status snapshot into
  `SymphonyStatus` on demand. The v2 CLIs use the existing instance registry and
  default endpoint for no-source live discovery, while explicit `--fixture`
  remains fixture-only.
- **Why:** This keeps fixture mode intact while letting `cockpit` and
  `capabilities` observe a real local daemon without starting a second server or
  making operators paste the endpoint for the common local case.

## Reversal notes

The spike is mostly contained in `src/v2/`, `test/v2/`, `test/fixtures/v2/`,
and `docs/v2/`, with additive CLI/package wiring and the daemon/server bridge
that exposes `/v2/*` from the existing local listener.
