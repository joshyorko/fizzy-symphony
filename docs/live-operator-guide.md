# Live Operator Guide

Use this when you want to run Fizzy Symphony from a clean checkout against a
real Fizzy board and a real Codex CLI login.

## 1. Install or Open the Devcontainer

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

RCC is the preferred runner because it gives you the same Python, Node, Git,
Codex SDK, Robocorp, and SQLite adapter environment every time. Install it from
Josh's tap or from the `joshyorko/rcc` releases:

```bash
brew tap joshyorko/tools
brew install joshyorko/tools/rcc
```

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
rcc --version
rcc ht vars -r robots/workitems/robot.yaml --json
rcc run -r robots/workitems/robot.yaml --dev -t Doctor --silent
rcc run -r robots/workitems/robot.yaml --dev -t SmokeSQLiteWorkitemFlow \
  -e robots/workitems/devdata/env-sqlite.json --silent
```

## 4. Run One Live Card From Your Own Prompt

The recommended operator path is the service-style CLI. It writes a local
`.fizzy-symphony/config.json` and `.fizzy-symphony/env.json`, then delegates to
RCC under the hood.

```bash
mkdir -p tmp/rails-todo-live

fizzy-symphony setup \
  --workspace "$PWD/tmp/rails-todo-live" \
  --prompt-file devdata/rails-todo.prompt.md \
  --board-name "Fizzy Symphony Rails Todo" \
  --card-title "Build a simple Rails todo app" \
  --run-mode once

fizzy-symphony start --detach
fizzy-symphony status
```

With no board/card values, `FizzySymphony` creates a fresh live board and card,
adds the default custom columns, runs Codex through SQLite workitems, comments
back, moves the card according to the golden ticket completion tag, and prints a
cleanup command for the disposable board. The default disposable board golden
ticket moves completed work cards to `Done`.

For foreground operation, use:

```bash
fizzy-symphony start
```

For lower-level debugging, the equivalent RCC command remains:

```bash
rcc run -r robots/workitems/robot.yaml -t FizzySymphony -e .fizzy-symphony/env.json --silent
```

For repeatable runs, create a tiny local env file from the template:

```bash
cp robots/workitems/devdata/env-prompt-card.example.json env.local.json
```

Edit at least:

- `FIZZY_SYMPHONY_WORKSPACE`
- `FIZZY_SYMPHONY_PROMPT`

`FIZZY_SYMPHONY_WORKSPACE` accepts an absolute path, a relative path, or a Git
URL. When it is a Git URL, the robot clones it into the output workspace before
running Codex. Set `FIZZY_SYMPHONY_GIT_REF` for a branch, tag, or commit. For
private repos, use normal Git auth: SSH agent/keys, a credential helper, or an
HTTPS URL/token that `git clone` can use.

Then run:

```bash
rcc run -r robots/workitems/robot.yaml -t FizzySymphony -e env.local.json --silent
```

The workitem adapter, queue names, SQLite files, Codex model, sandbox, and
approval policy are internal defaults. You only need to put them in an env file
when deliberately overriding the robot.

To use an existing board instead, provide the real board id, card number, and
the real custom column id for your handoff column:

```bash
fizzy column list --board <board id> --agent --quiet
fizzy card show <card number> --agent --quiet
```

Fill:

- `FIZZY_SYMPHONY_BOARD_ID`
- `FIZZY_SYMPHONY_CARD_NUMBER`
- `FIZZY_SYMPHONY_WORKSPACE`
- `FIZZY_SYMPHONY_PROMPT`
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

## Robot-Level Tests

The repo includes Robot Framework tests modeled after `joshyorko/rcc`'s
`robot_tests` style. They run real RCC commands and assert robot output and
artifacts:

```bash
uvx --from robotframework robot --outputdir robots/workitems/output/robot-tests \
  robot_tests/fizzy_symphony.robot
```

These tests do not mutate a live Fizzy board. The `FizzySymphonyContractTest`
dev task fakes the Fizzy boundary and the Codex SDK boundary while exercising
the real RCC task, SQLite adapter, board/card bootstrap, worker, and reporter
flow.

## Useful Defaults

- Codex model: `gpt-5.4-mini`
- Codex approval policy: `never`
- Codex sandbox: `workspace-write`
- RCC adapter: SQLite via `robocorp-adapters-custom`
- Fizzy system lanes are built in: `Maybe?`, `Not Now`, and `Done`

## Raw Python

RCC is preferred, but the implementation is plain Python. If you install the
same libraries yourself, you can run the same robot without RCC:

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -e ".[robot]"
python -m pip install -r robots/workitems/requirements.txt
python robots/workitems/run_fizzy_symphony.py --env-json env.local.json
```

The raw Python path still expects the external CLIs it shells out to: `codex`,
`fizzy`, and `git` when using a Git workspace URL.

## Execution Ownership

In the preferred path, RCC owns execution. The devcontainer is only the
workbench. The Python files are robot code that RCC runs inside the holotree
environment described by `robots/workitems/conda.yaml`. In the raw Python path,
your virtualenv owns those same dependencies instead.

The user-facing `FizzySymphony` task is a one-command harness around the intended
producer, worker, and reporter shape:

```text
env JSON -> producer builds a Fizzy workitem
SQLite adapter -> worker reserves the item
Codex SDK -> edits the workspace and returns proof
reporter -> posts the Fizzy comment/move when live mode is enabled
```
