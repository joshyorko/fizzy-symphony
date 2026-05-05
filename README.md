# fizzy-symphony

Fizzy-backed Symphony daemon scaffold.

<p align="center">
  <img src="docs/assets/fizzy-symphony-logo.png" alt="fizzy-symphony logo" width="180">
</p>

New here? Start with the beginner runbook: [docs/user-guide.md](docs/user-guide.md).

## Current Status

The first MVP selects Node.js ESM with no external runtime dependencies. As of 2026-05-01, the
current local baseline is 268/268 passing via `npm test` on Node v25.9.0. `package.json`
intentionally declares Node `>=25` until the project verifies a lower supported runtime.

The current implementation covers config generation/parsing, setup validation hooks, golden-ticket
startup validation, route decisions, claim markers, workspace metadata, workflow loading/rendering,
status snapshots, live Fizzy HTTP client wiring, live-comment and rich-text marker normalization,
live account-slug and tag-title normalization, verify-before-renew claim leases, workspace
preparation failure release, proof-verified cleanup guards, canonical workspace/proof path containment,
workflow cache fallback, visible capacity refusals, webhook freshness/self-event filtering,
non-looping runner failure markers, runner session stop, and a real Codex CLI app-server runner
behind the SDK-shaped runner interface.

Fizzy API calls now go through an SDK-backed adapter boundary: the daemon-facing contract stays in
`src/fizzy-client.js`, while the default live implementation uses the official Fizzy TypeScript SDK
under `src/fizzy-sdk-adapter.js`. See [docs/fizzy-sdk-adapter.md](docs/fizzy-sdk-adapter.md) for the
adapter boundary and migration matrix.

Disposable-board live smoke passed on 2026-04-29 against a private operator-provided Fizzy instance.
It proved identity, board/card/golden-ticket creation, startup validation, one real daemon poll,
unsafe-route refusal, and no destructive cleanup. Live webhook delivery is still not smoked.
Same-thread continuation above `agent.max_turns: 1` is intentionally rejected by config validation
until it is implemented.

## Commands

Run these from the repository root:

```sh
npm install
node bin/fizzy-symphony.js setup
node bin/fizzy-symphony.js start
node bin/fizzy-symphony.js status
npm test
```

Interactive `setup` asks for missing Fizzy URL/token values, creates the starter board route,
writes `.fizzy-symphony/config.yml`, and creates `WORKFLOW.md` when the repo does not have one.
`init` remains a compatible alias for the same first-run flow.

Config loading supports JSON and the generated YAML format from `config.example.yml`; setup,
validate, status, and daemon commands default to `.fizzy-symphony/config.yml`.

For a step-by-step smoke test with a real Fizzy board, see [docs/user-guide.md](docs/user-guide.md).

## Influences

`fizzy-symphony` is its own daemon and spec. It is inspired by OpenAI Symphony's reconciliation
model and by the board-native workflow ideas explored in `fizzy-popper`.
