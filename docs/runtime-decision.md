# Runtime Decision

Status: Decided.

Selected runtime: TypeScript-shaped Node.js ESM using built-in modules for the first MVP scaffold.

This document records runtime tradeoffs for the first `fizzy-symphony` implementation. `SPEC.md`
remains runtime-neutral and is the behavioral contract.

Verified inputs as of 2026-04-29:

- OpenAI's Codex SDK announcement says the SDK is available for TypeScript today, with more
  languages planned.
- OpenAI's Codex App Server article describes a language-neutral JSON-RPC over stdio/JSONL protocol,
  with clients implemented in Go, Python, TypeScript, Swift, and Kotlin. It also describes generated
  TypeScript definitions and JSON Schema bundles for other languages.

Sources:

- https://openai.com/index/codex-now-generally-available/
- https://openai.com/index/unlocking-the-codex-harness/

## Decision

The first implementation uses Node.js ESM. The initial scaffold deliberately avoids external runtime
dependencies and keeps all Codex execution behind the SDK-shaped runner abstraction required by
`SPEC.md`.

The selected runtime MUST support:

- long-running local daemon operation
- bounded concurrent card workers
- local HTTP status and webhook server
- deterministic workspace and git worktree management
- file locks, process lifecycle, and port management
- Codex SDK or App Server runner integration
- safe shutdown, cancellation, and cleanup

## Rationale

Node.js is selected for the first MVP because the previous implementation worktree already provides
a tested scaffold for strict config parsing, setup validation, golden-ticket startup validation, and
the runner contract. Reusing that scaffold gets the product to a fake-Fizzy/fake-runner vertical
slice faster while preserving the runtime-neutral contracts in the spec.

This is a pragmatic MVP decision, not a declaration that Node.js is the best long-term daemon
runtime. The implementation must keep process supervision, file locking, app-server communication,
and cleanup boundaries explicit so a future Go or Elixir rewrite can follow the same contracts.

## Options

### Go

Best if the priority is a boring local tool: single binary, strong process/file/port handling, good
concurrency, simple deployment, and a straightforward Codex App Server JSON-RPC client.

Tradeoff: more code starts from scratch, including the Fizzy client, setup wizard, and generated or
manual App Server bindings.

### Elixir

Best if the priority is the cleanest Symphony-style orchestrator: supervision trees, GenServers,
timers, retries, process monitoring, bounded concurrency, and status surfaces.

Tradeoff: more from-scratch Fizzy integration, less familiar local packaging, and likely direct
App Server JSON-RPC rather than a native SDK.

### TypeScript / Node.js

Best if the priority is fastest reuse and current SDK convenience: implementation reuse, npm packaging,
HTTP/webhook ergonomics, and the currently available Codex TypeScript SDK.

Tradeoff: long-running supervision, stale process cleanup, locks, and child-process safety require
explicit discipline. TypeScript SHOULD win only if implementation reuse or SDK convenience is decisive.

Decision note: TypeScript-shaped Node.js won here because reuse from the prior worktree is decisive
for this implementation pass. The MVP still defaults to the Codex CLI app-server fallback unless an
exact supported SDK package and contract are selected.

### Python

Best if Python SDK stability becomes decisive or quick prototyping is the top priority.

Tradeoff: weaker daemon/supervision and local packaging ergonomics than Go or Elixir for an
always-on local tool.

## Original Recommendation

For a fresh spec-first implementation, prefer:

1. Go for the best local daemon and single-binary operational story.
2. Elixir for the best orchestration and supervision model.
3. TypeScript only if implementation reuse or the current official Codex SDK is the deciding factor.
4. Python only if a stable Python SDK path becomes the deciding factor.

This recommendation remains useful for future rewrites, but the first implementation now has a
concrete runtime decision above.
