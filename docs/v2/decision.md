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
  In the spike, every operator command is **validated**, **availability-checked**,
  and then **recorded as a dry-run event** (`command.dry-run.<type>`) with outcome
  `"dry-run"`. No real side effect is performed.
- **Why:** The brief forbids fake controls. A button that *pretends* to cancel a
  run is a fake control. A button that honestly reports "validated, would dispatch
  `run.cancel run_426` — not wired in spike" is not. Dry-run is the honest middle:
  the full validation/availability path is real, only the final effect is stubbed.
- **Single choke point:** `runtime.submitCommand` is the *only* place a command is
  evaluated or applied. Render and model code never mutate state.

## 5. Fizzy and Codex adapters are boundaries, not fakes

- **Decision:** `createFizzyAdapter` and `createCodexAdapter` implement the real
  port interfaces but **throw on live operations** with explicit codes
  (`FIZZY_ADAPTER_NOT_WIRED`, `CODEX_ADAPTER_NOT_WIRED`). Their `describe()` /
  `health()` honestly advertise "not wired."
- **Why:** The spike must prove the *shape* of the ports without pretending to
  talk to a real Fizzy or Codex. The fakes (`createFakeFizzyPort`,
  `createFakeCodexRunner`) are the deterministic, fixture-backed implementations
  used by tests and the cockpit.
- **FizzyPort is independent of the SDK.** The port types are hand-written in
  `core/types.ts` and do not import or re-export `@37signals/fizzy` types. The SDK
  is one possible adapter `mode`, not the contract.
- **CodexRunnerPort is SDK-compatible.** Its method set
  (`detect/health/startSession/startTurn/streamTurn/cancelTurn/stopSession/terminateOwnedProcess`)
  mirrors the Codex app-server/SDK lifecycle so a real adapter can be dropped in.

## 6. Default cockpit fixture

- **Decision:** `fizzy-symphony cockpit` with no source flags loads
  `test/fixtures/v2/ready.json`.
- **Why:** A spike needs a zero-arg happy path for demos. Documented here so it is
  not mistaken for production behavior.

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

## Reversal notes

The entire spike is contained in `src/v2/`, `test/v2/`, `test/fixtures/v2/`,
`docs/v2/`, and two additive edits (`bin/fizzy-symphony.js`, `package.json`).
Deleting those directories and reverting the two edits removes v2 with zero impact
on v1.
