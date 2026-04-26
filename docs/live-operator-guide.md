# Live Operator Guide

Use this when you want to run Fizzy Symphony from a clean checkout against a
real Fizzy board and a real Codex CLI login.

## 1. Open the Devcontainer

This repo includes a devcontainer using `ghcr.io/joshyorko/ror:latest`.

Open the repo in the container, then verify the Python package installed:

```bash
fizzy-symphony version
python -m pytest -q
```

The devcontainer forwards `FIZZY_TOKEN`, `FIZZY_API_URL`, `FIZZY_PROFILE`, and
`FIZZY_BOARD` from the host when those variables exist. It mounts `.config/fizzy`
so Fizzy auth can be reused. It does not mount host `.codex`; log into Codex
inside the devcontainer so auth, sessions, and conversation history stay
container-local. RCC is installed inside the container with Homebrew and builds
its own container-local holotree with `rcc ht vars`.

## 2. Authenticate Codex and Fizzy

RCC does not need auth for this project. It only builds and runs the local robot
environment.

Codex CLI auth must exist inside the devcontainer because that is the
environment that runs the robot. This project assumes the Codex subscription
login flow, not API-key worker auth:

```bash
codex login
codex login status
```

Fizzy auth is separate:

```bash
fizzy setup
# or:
fizzy auth login "$FIZZY_TOKEN" --profile 1

fizzy auth status
fizzy doctor
fizzy board list
```

## 3. Verify RCC Locally

```bash
brew tap joshyorko/tools
brew install joshyorko/tools/rcc
rcc --version
rcc ht vars -r robots/workitems/robot.yaml --json
rcc run -r robots/workitems/robot.yaml -t Doctor --silent
rcc run -r robots/workitems/robot.yaml -t SmokeSQLiteWorkitemFlow \
  -e robots/workitems/devdata/env-sqlite.json --silent
```

## 4. Run One Live Card From Your Own Prompt

Create or choose a Fizzy board and card. Get the board id, card number, and the
real custom column id for your handoff column:

```bash
fizzy column list --board <board id> --agent --quiet
fizzy card show <card number> --agent --quiet
```

Then run one card through SQLite workitems and Codex SDK:

```bash
export FIZZY_SYMPHONY_BOARD_ID=<board id>
export FIZZY_SYMPHONY_CARD_NUMBER=<card number>
export FIZZY_SYMPHONY_WORKSPACE=/absolute/path/to/project
export FIZZY_SYMPHONY_PROMPT="$(cat prompt.md)"
export FIZZY_SYMPHONY_HANDOFF_COLUMN_ID=<Synthesize & Verify column id>
export FIZZY_SYMPHONY_LIVE_FIZZY=1

rcc run -r robots/workitems/robot.yaml -t PromptCardSmoke --silent
```

The robot verifies the board/card, runs Codex with the official Python SDK,
writes through `workspace-write` sandbox mode, creates a workitem output, posts a
Fizzy comment, and moves the card to the handoff column.

## 5. Run the Disposable Dashboard Smoke

For a bigger visual board test:

```bash
python test-projects/workai-smoke/bootstrap_board.py --live --create-board
```

Copy the printed `smoke_env` values, then run:

```bash
export WORKAI_SMOKE_BOARD_ID=<printed board id>
export WORKAI_SMOKE_CARD_NUMBERS=<printed fixture-to-live mapping>
export WORKAI_SMOKE_GOLDEN_CARD_NUMBER=<printed golden card number>
export WORKAI_SMOKE_HANDOFF_COLUMN_ID=<printed handoff column id>
export WORKAI_SMOKE_LIVE_FIZZY=1

rcc run -r robots/workitems/robot.yaml -t WorkAIProductionSmoke --silent
```

When finished, delete only the disposable board:

```bash
fizzy board delete <printed board id>
```

## Useful Defaults

- Codex model: `gpt-5.4-mini`
- Codex approval policy: `never`
- Codex sandbox: `workspace-write`
- RCC adapter: SQLite via `robocorp-adapters-custom`
- Fizzy system lanes are built in: `Maybe?`, `Not Now`, and `Done`
