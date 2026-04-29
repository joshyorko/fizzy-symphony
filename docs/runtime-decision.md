# Runtime Decision

Status: Selected.

The first `fizzy-symphony` implementation runtime is **Node.js with ESM JavaScript and no external
runtime dependencies**.

## Decision

Task 1 implements a Node package using:

- ESM `.js` modules via `"type": "module"`
- Node v25+ built-ins only
- `node:test` and `node:assert` for tests
- `node:fs`, `node:path`, `node:crypto`, and related built-ins for local validation
- a `bin/fizzy-symphony.js` CLI entrypoint
- no `tsc`, `tsx`, transpiler, package downloads, or runtime dependencies

The package is TypeScript/Node-compatible in shape, but TypeScript is not required to build, run, or
test the MVP scaffold.

## Package And Local Install Shape

The local package exposes:

```sh
npm test
node bin/fizzy-symphony.js setup --template-only --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js validate --parse-only --config config.json
node bin/fizzy-symphony.js daemon
```

`setup --template-only` writes the annotated YAML template. The tested setup module accepts injected
Fizzy and runner clients for identity, board, tag, user, entropy, webhook, route, and runner
validation without network access in tests.

`validate --parse-only` intentionally parses JSON config files for Task 1. Annotated YAML generation
is supported, but YAML parsing is deferred until a parser decision is made.

`daemon` is a command stub for Task 1 and reports that later tasks implement the loop.

## Runner Decision

The MVP runner path is the Codex CLI app-server behind an SDK-shaped interface. Task 1 provides
runner detection and health hooks through injected fake runner dependencies; the real app-server
runner implementation is deferred to the runner task.

The Codex SDK remains optional. It should only become the preferred runner after an exact stable SDK
package and contract are selected. Until then, generated config defaults to `cli_app_server` so
startup behavior does not depend on package downloads.

## Tradeoff

Node gives the fastest no-install implementation path in this workspace because Node v25 and npm are
already present while Go is not. It also aligns with the currently available TypeScript-oriented
Codex ecosystem.

The cost is operational discipline: long-running supervision, process cleanup, file locking,
workspace cleanup, and child-process safety must be explicit in code and tests. Later phases should
keep daemon/process behavior narrow, observable, and covered before enabling real card dispatch.
