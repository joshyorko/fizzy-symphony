# fizzy-symphony User Guide

This guide is for someone who has never used the system before.

## What It Does

`fizzy-symphony` is a local daemon that turns Fizzy cards into Codex work.

The board stays the source of truth:

1. A golden card in a watched column defines the route and rules.
2. A normal card in that same column is the work request.
3. The daemon claims the normal card.
4. Codex runs in an isolated git worktree.
5. The daemon comments with the result.
6. The route completion policy moves, closes, or only comments on the card.

The golden card is the instruction ticket. The normal cards are the tasks.

## Requirements

Run this on the Bluefin host or another Linux shell from the repo root. Do not run it inside CI for a local smoke test.

You need:

- Node.js `>=25`
- `npm`
- `codex` CLI installed and authenticated
- `fizzy` CLI installed
- a Fizzy API token
- a git repo with a `WORKFLOW.md`

Install repo dependencies:

```sh
npm install
```

Load credentials:

```sh
set -a
source .env
set +a

export FIZZY_API_URL="${FIZZY_API_URL:-https://app.fizzy.do}"
export FIZZY_API_TOKEN="${FIZZY_API_TOKEN:-${FIZZY_TOKEN:-${FIZYY_TOKEN:-}}}"
```

For a self-hosted Fizzy instance, set `FIZZY_API_URL` to that base URL before starting the daemon.
New setups should use `FIZZY_API_TOKEN`; the last fallback only supports older local `.env` files.

Check the basic tools:

```sh
node --version
codex --version
fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" doctor
npm test
```

## Fast Local Smoke

If this checkout already has `.fizzy-symphony/live-smoke-config.yml` and `.fizzy-symphony/live-smoke-state.json`, use those files for the quickest test.

Create a tiny work card:

```sh
BOARD_ID=$(node -e 'console.log(require("./.fizzy-symphony/live-smoke-state.json").board_id)')
READY_ID=$(node -e 'console.log(require("./.fizzy-symphony/live-smoke-state.json").ready_column_id)')

CARD=$(fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" card create \
  --board "$BOARD_ID" \
  --title "Smoke task: hello from fizzy-symphony" \
  --description "Reply with one sentence confirming this smoke test worked." \
  --jq '.data.number')

fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" card column "$CARD" \
  --column "$READY_ID" \
  --jq '{number: .data.number}'

fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" card publish "$CARD" \
  --jq '{number: .data.number, status: .data.status}'

echo "Created card $CARD"
```

Start the daemon in a second terminal:

```sh
node bin/fizzy-symphony.js daemon --config .fizzy-symphony/live-smoke-config.yml
```

Watch the local daemon status:

```sh
curl -fsS http://127.0.0.1:4567/status
```

Check the Fizzy card:

```sh
fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" card show "$CARD" \
  --jq '{number: .data.number, title: .data.title, column: (.data.column.name // .data.column_id), closed: .data.closed, tags: [.data.tags[]? | if type == "string" then . else (.title // .name // .slug) end]}'
```

Success means the card has a result comment and an `agent-completed-*` tag. If the route uses `move-to-done`, the card should be in the Done column. If the route uses `close-on-complete`, the card should show `closed: true`.

Stop the daemon with `Ctrl-C`.

## Make A New Board Route

Create or pick a Fizzy board, then create the columns you want:

```sh
BOARD_ID=$(fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" board create \
  --name "Agent Smoke Board" \
  --jq '.data.id')

fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" board publish "$BOARD_ID"

READY_ID=$(fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" column create \
  --board "$BOARD_ID" \
  --name "Ready" \
  --jq '.data.id')

DONE_ID=$(fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" column create \
  --board "$BOARD_ID" \
  --name "Done" \
  --jq '.data.id')

echo "Done column is $DONE_ID"
```

Create the golden instruction card in the source column:

```sh
GOLDEN=$(fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" card create \
  --board "$BOARD_ID" \
  --title "Agent route: Ready" \
  --description "Use Codex to do small safe tasks from this column. Complete with move-to-done." \
  --jq '.data.number')

fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" card column "$GOLDEN" --column "$READY_ID"
fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" card golden "$GOLDEN"
fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" card tag "$GOLDEN" --tag agent-instructions
fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" card tag "$GOLDEN" --tag codex
fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" card tag "$GOLDEN" --tag move-to-done
fizzy --api-url "$FIZZY_API_URL" --token "$FIZZY_API_TOKEN" card publish "$GOLDEN"
```

Use `close-on-complete` instead of `move-to-done` when you want successful task cards closed.

Create a config:

```sh
node bin/fizzy-symphony.js setup \
  --config .fizzy-symphony/config.yml \
  --board "$BOARD_ID" \
  --workspace-repo .
```

Validate it:

```sh
node bin/fizzy-symphony.js validate --config .fizzy-symphony/config.yml
```

Start the daemon:

```sh
node bin/fizzy-symphony.js daemon --config .fizzy-symphony/config.yml
```

Now create normal cards in the Ready column. Those cards are the work queue.

## How To Think About `WORKFLOW.md`

`WORKFLOW.md` is the agent-facing operating manual for the repo. Keep it short and direct:

- what kind of work is allowed
- how to run tests
- what counts as done
- what not to touch
- how to report completion

The daemon loads this file into the Codex task context before it runs a card.

## Common Commands

```sh
node bin/fizzy-symphony.js setup --template-only --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js validate --parse-only --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js validate --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js daemon --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js status --config .fizzy-symphony/config.yml
```

If the daemon is running, the local HTTP status endpoint is usually:

```sh
curl -fsS http://127.0.0.1:4567/status
```
