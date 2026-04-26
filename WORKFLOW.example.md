# WORKFLOW.example.md

This example shows the current operator workflow for running Fizzy Symphony from
one RCC command. RCC owns the runtime, Fizzy owns the visible board/cards, SQLite
workitems own execution custody, and Codex SDK owns the coding harness.

## Runtime Contract

```yaml
runtime:
  runner: rcc
  robot: robots/workitems/robot.yaml
  task: FizzySymphony
  run_mode: once

tracker:
  kind: fizzy
  board_id: null
  bootstrap_when_board_missing: true
  immutable_system_lanes:
    - Maybe?
    - Not Now
    - Done
  created_custom_columns:
    - Ready for Agents
    - In Flight
    - Needs Input
    - Synthesize & Verify
    - Ready to Ship

golden_ticket:
  column: Ready for Agents
  actual_golden_card: true
  tags:
    - agent-instructions
    - codex
    - move-to-done

workitems:
  adapter: sqlite
  custody: lease, dedupe, output payload, reporter retry

codex:
  runner: sdk
  model: gpt-5.4-mini
  approval_policy: never
  sandbox: workspace-write
```

If `FIZZY_SYMPHONY_BOARD_ID` is blank, the robot creates a disposable board,
creates a real golden ticket, creates one seed work card from the prompt, moves
that card into `Ready for Agents`, runs Codex, comments proof back to Fizzy, and
moves the card to `Done`.

If `FIZZY_SYMPHONY_BOARD_ID` is set, the robot discovers existing golden tickets
on that board. It does not silently add columns or golden tickets to an existing
board.

## Rails Todo Example

Create a workspace for the app Codex will build:

```bash
mkdir -p tmp/rails-todo-live
```

Create a local env file:

```bash
cat > env.rails-todo.local.json <<EOF
{
  "FIZZY_SYMPHONY_WORKSPACE": "$PWD/tmp/rails-todo-live",
  "FIZZY_SYMPHONY_PROMPT_FILE": "devdata/rails-todo.prompt.md",
  "FIZZY_SYMPHONY_BOARD_NAME": "Fizzy Symphony Rails Todo",
  "FIZZY_SYMPHONY_CARD_TITLE": "Build a simple Rails todo app",
  "FIZZY_SYMPHONY_RUN_MODE": "once",
  "FIZZY_SYMPHONY_BOARD_ID": "",
  "FIZZY_SYMPHONY_CARD_NUMBER": ""
}
EOF
```

Run the full orchestration:

```bash
rcc run -r robots/workitems/robot.yaml -t FizzySymphony -e env.rails-todo.local.json --silent
```

The run should print:

- disposable board id and URL
- golden ticket card number
- work card number
- Codex SDK thread/run ids
- summary/status artifact paths
- cleanup command for the disposable board

Clean up the disposable board after inspecting it:

```bash
fizzy board delete <printed board id>
```

## Prompt File

The Rails todo prompt lives at:

```text
robots/workitems/devdata/rails-todo.prompt.md
```

That prompt asks Codex to build a simple Rails todo app with SQLite, CRUD,
completion toggling, basic tests, and validation output.
