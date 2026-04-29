# fizzy-symphony

Fizzy-backed Symphony daemon scaffold.

## Current Status

The first MVP selects Node.js ESM with no external runtime dependencies. As of 2026-04-29, the
current local baseline is 157/157 passing via `npm test`.

The current implementation covers config generation/parsing, setup validation hooks, golden-ticket
startup validation, route decisions, claim markers, workspace metadata, workflow loading/rendering,
status snapshots, an injected fake-Fizzy/fake-runner reconciliation slice, and a real Codex CLI
app-server runner behind the SDK-shaped runner interface.

Live Fizzy HTTP, full completion handling, and hardening/smoke tests are later MVP layers. The
Codex CLI app-server runner keeps process/protocol seams injectable for tests.

## Commands

Run these from the `fizzy-symphony` workspace, not from the sibling `fizzy-popper` checkout:

```sh
cd <fizzy-symphony checkout>
npm test
node bin/fizzy-symphony.js setup --template-only --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js validate --parse-only --config config.json
node bin/fizzy-symphony.js daemon
```

Config loading supports JSON and the generated YAML format from `config.example.yml`.

