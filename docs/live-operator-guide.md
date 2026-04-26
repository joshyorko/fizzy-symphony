# Live Operator Guide

Use this when you want to run Fizzy Symphony from a clean checkout against a
real Fizzy board and a real Codex CLI login.

## 1. Open the Devcontainer

This repo includes a devcontainer using `ghcr.io/joshyorko/ror:latest`.

Open the repo in the container. The devcontainer installs RCC with Homebrew and
prepares the robot environment by running `rcc ht vars`.

You only need these checks when diagnosing setup:

```bash
rcc --version
rcc ht vars -r robots/workitems/robot.yaml --json
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

## 3. Optional Dev Checks

```bash
brew tap joshyorko/tools
brew install joshyorko/tools/rcc
rcc --version
rcc ht vars -r robots/workitems/robot.yaml --json
rcc run -r robots/workitems/robot.yaml --dev -t Doctor --silent
rcc run -r robots/workitems/robot.yaml --dev -t SmokeSQLiteWorkitemFlow \
  -e robots/workitems/devdata/env-sqlite.json --silent
```

## 4. Run One Live Card From Your Own Prompt

Create a local env file from the template:

```bash
cp robots/workitems/devdata/env-prompt-card.example.json env.local.json
```

The template is set up for a fresh live smoke run. With
`FIZZY_SYMPHONY_CREATE_BOARD=1` and `FIZZY_SYMPHONY_CREATE_CARD=1`, the robot
creates a new Fizzy board, adds the default custom columns, creates the prompt
card, runs Codex through SQLite workitems, comments back, moves the card to
`Synthesize & Verify`, and prints a cleanup command for the disposable board.

Edit at least:

- `FIZZY_SYMPHONY_WORKSPACE`
- `FIZZY_SYMPHONY_PROMPT_FILE` if you do not want the sample prompt

Then run:

```bash
rcc run -r robots/workitems/robot.yaml -t FizzySymphony -e env.local.json --silent
```

To use an existing board instead, set both create flags to `0`, then provide the
real board id, card number, and the real custom column id for your handoff
column:

```bash
fizzy column list --board <board id> --agent --quiet
fizzy card show <card number> --agent --quiet
```

Fill:

- `FIZZY_SYMPHONY_BOARD_ID`
- `FIZZY_SYMPHONY_CARD_NUMBER`
- `FIZZY_SYMPHONY_WORKSPACE`
- `FIZZY_SYMPHONY_PROMPT_FILE`
- `FIZZY_SYMPHONY_HANDOFF_COLUMN_ID`

Then run one card through SQLite workitems and Codex SDK:

```bash
rcc run -r robots/workitems/robot.yaml -t FizzySymphony -e env.local.json --silent
```

The robot verifies the board/card, runs Codex with the official Python SDK,
writes through `workspace-write` sandbox mode, creates a workitem output, posts a
Fizzy comment, and moves the card to the handoff column.

## 5. Run the Disposable Dashboard Smoke

For a bigger visual board test:

```bash
python test-projects/workai-smoke/bootstrap_board.py --live --create-board
```

Copy the printed `smoke_env` values into an env JSON file, then run:

```bash
rcc run -r robots/workitems/robot.yaml --dev -t WorkAIProductionSmoke -e workai-smoke.env.json --silent
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

## Execution Ownership

RCC owns execution. The devcontainer is only the workbench. The Python files are
robot code that RCC runs inside the holotree environment described by
`robots/workitems/conda.yaml`.

The user-facing `FizzySymphony` task is a one-command harness around the intended
producer, worker, and reporter shape:

```text
env JSON -> producer builds a Fizzy workitem
SQLite adapter -> worker reserves the item
Codex SDK -> edits the workspace and returns proof
reporter -> posts the Fizzy comment/move when live mode is enabled
```
