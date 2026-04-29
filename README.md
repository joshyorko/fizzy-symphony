# fizzy-symphony

Fizzy-backed Symphony daemon scaffold.

## Current Status

The first MVP selects Node.js ESM with no external runtime dependencies. As of 2026-04-29, the
current local baseline is 216/216 passing via `npm test` on Node v25.9.0. `package.json`
intentionally declares Node `>=25` until the project verifies a lower supported runtime.

The current implementation covers config generation/parsing, setup validation hooks, golden-ticket
startup validation, route decisions, claim markers, workspace metadata, workflow loading/rendering,
status snapshots, live Fizzy HTTP client wiring, live-comment routing markers, timed claim renewal,
workspace preparation failure release, webhook freshness/self-event filtering, runner session stop,
and a real Codex CLI app-server runner behind the SDK-shaped runner interface.

Disposable-board live smoke is still gated on explicit credentials/operator approval. Same-thread
continuation above `agent.max_turns: 1` is intentionally rejected by config validation until it is
implemented. The Codex CLI app-server runner keeps process/protocol seams injectable for tests.

## Commands

Run these from the `fizzy-symphony` workspace, not from the sibling `fizzy-popper` checkout:

```sh
cd <fizzy-symphony checkout>
npm test
node bin/fizzy-symphony.js setup --template-only --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js validate --parse-only --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js daemon
```

Config loading supports JSON and the generated YAML format from `config.example.yml`; setup,
validate, status, and daemon commands default to `.fizzy-symphony/config.yml`.

