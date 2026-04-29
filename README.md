# fizzy-symphony

Fizzy-backed Symphony daemon scaffold.

## Current Status

The first MVP selects Node.js ESM with no external runtime dependencies. As of 2026-04-29, the
current local baseline is 75/75 passing via `npm test`.

The current implementation covers config generation/parsing, setup validation hooks, golden-ticket
startup validation, route decisions, claim markers, workspace metadata, workflow loading/rendering,
status snapshots, and an injected fake-Fizzy/fake-runner reconciliation slice.

Live Fizzy and Codex integrations are still injected test seams. Real Fizzy HTTP, real Codex
app-server execution, full completion handling, and hardening/smoke tests are later MVP layers.

## Commands

Run these from the `fizzy-symphony` workspace, not from the sibling `fizzy-popper` checkout:

```sh
cd /var/home/kdlocpanda/second_brain/Resources/virtualization/docker/37signals/agent_stuff/fizzy-symphony
npm test
node bin/fizzy-symphony.js setup --template-only --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js validate --parse-only --config config.json
node bin/fizzy-symphony.js daemon
```

Config loading supports JSON and the generated YAML format from `config.example.yml`.

## Popper Handoff Runbook

`fizzy-popper` is currently the temporary Fizzy board and agent driver used to build this repository.
`fizzy-symphony` is the target daemon being built. Keep implementation work scoped to this repository
unless a card explicitly says otherwise.

See [docs/popper-handoff-runbook.md](docs/popper-handoff-runbook.md) for the local runbook covering
the Popper start context, board flow, golden-ticket assumptions, deferred gaps, and next-card order.
