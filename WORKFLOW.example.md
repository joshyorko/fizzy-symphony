# WORKFLOW.example.md

This example shows the current operator workflow for running Fizzy Symphony with
service-style commands. The `fizzy-symphony` CLI owns setup, start, status, and
board inspection; RCC still owns the contained Python/SQLite/Codex runtime under
the hood.

## Runtime Contract

```yaml
runtime:
  command_surface:
    - fizzy-symphony setup
    - fizzy-symphony start
    - fizzy-symphony status
    - fizzy-symphony boards
  runner: rcc
  robot: robots/workitems/robot.yaml
  task: FizzySymphony

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

Create local config and env files:

```bash
fizzy-symphony setup \
  --workspace "$PWD/tmp/rails-todo-live" \
  --prompt-file devdata/rails-todo.prompt.md \
  --board-name "Fizzy Symphony Rails Todo" \
  --card-title "Build a simple Rails todo app" \
  --run-mode once
```

Start the orchestration in the foreground:

```bash
fizzy-symphony start
```

Or start it detached so your terminal returns immediately:

```bash
fizzy-symphony start --detach
fizzy-symphony status
tail -f .fizzy-symphony/service.log
```

Inspect available boards:

```bash
fizzy-symphony boards
```

When the run prints or records a cleanup command, delete only the disposable
board after inspection:

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
