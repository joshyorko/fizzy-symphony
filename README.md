# fizzy-symphony

Fizzy-backed Symphony daemon scaffold.

<p align="center">
  <img src="docs/assets/fizzy-symphony-logo.png" alt="fizzy-symphony logo" width="180">
</p>

New here? Start with the beginner runbook: [docs/user-guide.md](docs/user-guide.md).

## Current Status

The first MVP selects Node.js ESM with Terminal Kit for interactive terminal surfaces. As of
2026-05-07, the current local baseline is 318/318 passing via `npm test` on Node v25.9.0.
`package.json` intentionally declares Node `>=25` until the project verifies a lower supported
runtime.

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
node bin/fizzy-symphony.js dashboard
node bin/fizzy-symphony.js status
npm test
```

`setup` is the primary first-run command. Plain guided setup asks for missing Fizzy URL/token
values, creates a starter board by default, previews mutating actions, and writes the compact
operator config to `.fizzy-symphony/config.yml`. Use `--mode existing --board BOARD_ID` to wire an
existing board, or `--adopt-starter --board BOARD_ID` when the board already has the starter route.
`init` remains as a deprecated compatibility alias for `setup`.

The board is the workflow surface: the golden card defines the route and normal cards are work.
`WORKFLOW.md` is optional repo policy that gets added to agent context when present. Setup leaves it
alone unless you explicitly choose create/append in the prompt or pass `--create-starter-workflow`
or `--augment-workflow`; use `--no-workflow-change` to keep scripted runs from touching it.

Setup hard-pins a Codex model in generated config instead of floating with whatever the Codex CLI
currently defaults to. Use `--model` or `--codex-model` during setup to override the pinned model,
and use `--reasoning-effort` or `--reasoning` to set the Codex reasoning effort. The generated config
keeps both choices visible:

```yaml
agent:
  default_model: gpt-5.4
  reasoning_effort: medium
  max_concurrent: 1
```

Maximum active agents stays on the existing concurrency contract: use `--max-agents` during setup,
or edit `agent.max_concurrent` in `.fizzy-symphony/config.yml`. Starter-board setup defaults it to
`1`.

Source protection ignores setup-owned `.fizzy-symphony/` dirt so generated config, status, and
workspace metadata do not block dispatch. Real changes in the source repo still block when the
clean-source policy is enabled; commit, stash, or change the policy deliberately before retrying.

`dashboard` observes the daemon's existing `/status` truth. Interactive TTY output refreshes by
default, `--once` prints a static snapshot, and non-TTY, CI, or dumb terminals use the same text
fallback. It does not define a separate workflow model.

Config loading supports JSON and generated YAML. Normal setup writes the compact operator config;
`setup --template-only` writes the fully annotated template. Setup, validate, status, dashboard, and
daemon commands default to `.fizzy-symphony/config.yml`.

For a step-by-step smoke test with a real Fizzy board, see [docs/user-guide.md](docs/user-guide.md).

## Influences

`fizzy-symphony` is its own daemon and spec. It is inspired by OpenAI Symphony's reconciliation
model and by the board-native workflow ideas explored in `fizzy-popper`.
