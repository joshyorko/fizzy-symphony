# fizzy-symphony

Fizzy-backed Symphony daemon scaffold.

## Current Status

The first MVP selects Node.js ESM with no external runtime dependencies. As of 2026-04-29, the
current local baseline is 226/226 passing via `npm test` on Node v25.9.0. `package.json`
intentionally declares Node `>=25` until the project verifies a lower supported runtime.

The current implementation covers config generation/parsing, setup validation hooks, golden-ticket
startup validation, route decisions, claim markers, workspace metadata, workflow loading/rendering,
status snapshots, live Fizzy HTTP client wiring, live-comment and rich-text marker normalization,
live account-slug and tag-title normalization, timed claim renewal failure cancellation, workspace
preparation failure release, proof-verified cleanup guards, canonical workspace path containment,
webhook freshness/self-event filtering, runner session stop, and a real Codex CLI app-server runner
behind the SDK-shaped runner interface.

Disposable-board live smoke passed on 2026-04-29 against the self-hosted Fizzy instance using board
`03g1c3lq3lrvkp72366u6c7mk`. It proved identity, board/card/golden-ticket creation, startup
validation, one real daemon poll, unsafe-route refusal, and no destructive cleanup. Live webhook
delivery is still not smoked. Same-thread continuation above `agent.max_turns: 1` is intentionally
rejected by config validation until it is implemented.

## Commands

Run these from the `fizzy-symphony` workspace, not from the sibling `fizzy-popper` checkout:

```sh
cd /var/home/kdlocpanda/second_brain/Resources/virtualization/docker/37signals/agent_stuff/fizzy-symphony
npm test
node bin/fizzy-symphony.js setup --template-only --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js validate --parse-only --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js daemon
```

Config loading supports JSON and the generated YAML format from `config.example.yml`; setup,
validate, status, and daemon commands default to `.fizzy-symphony/config.yml`.

## Popper Handoff Runbook

`fizzy-popper` is currently the temporary Fizzy board and agent driver used to build this repository.
`fizzy-symphony` is the target daemon being built. Keep implementation work scoped to this repository
unless a card explicitly says otherwise.

See [docs/popper-handoff-runbook.md](docs/popper-handoff-runbook.md) for the local runbook covering
the Popper start context, board flow, golden-ticket assumptions, deferred gaps, and next-card order.
