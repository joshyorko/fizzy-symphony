# fizzy-symphony

Fizzy-backed Symphony daemon scaffold.

Task 1 selects Node.js ESM with no external runtime dependencies. The current implementation covers
config generation/parsing, setup validation hooks, golden-ticket startup validation, completion
failure markers, and a CLI command scaffold.

## Commands

```sh
npm test
node bin/fizzy-symphony.js setup --template-only --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js validate --parse-only --config config.json
node bin/fizzy-symphony.js daemon
```

Task 1 parses JSON config for validation and generates annotated YAML from `config.example.yml`.
Live Fizzy and Codex integrations are injected in tests and are implemented for real in later tasks.
