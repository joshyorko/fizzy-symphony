# Architecture

## Overview

Fizzy Symphony is structured in three layers:

```
┌─────────────────────────────────────────────┐
│                   CLI Layer                  │
│         fizzy_symphony.cli  (cli.py)         │
│   - Argument parsing via argparse            │
│   - Sub-commands: plan, version              │
│   - Dry-run only; never spawns processes     │
└──────────────────────┬──────────────────────┘
                       │ calls
┌──────────────────────▼──────────────────────┐
│              Command Layer                   │
│      fizzy_symphony.commands (commands.py)   │
│   - build_card_list_command()                │
│   - build_card_show_command()                │
│   - build_card_column_command()              │
│   - build_comment_create_command()           │
│   - build_board_plan()                       │
│   - format_plan_as_text()                    │
│   - Pure functions; no I/O or subprocesses   │
└──────────────────────┬──────────────────────┘
                       │ uses
┌──────────────────────▼──────────────────────┐
│               Domain Model Layer             │
│       fizzy_symphony.models (models.py)      │
│   - Agent, CardAdapter, Board, FizzyConfig   │
│   - Python dataclasses with validation       │
│   - No external dependencies                 │
└─────────────────────────────────────────────┘
```

## Revised Scaffold Model

The scaffold now treats **Fizzy as the board/tracker layer** instead of a generic
task runner. Tracker items are normalized into `CardAdapter` objects, and a
`Board` groups those cards into a dry-run execution plan.

Phase 0 uses the `joshyorko/agent-skills` Fizzy skill as the CLI contract. That
means the dry-run builder mirrors real Fizzy commands even before any live
execution exists.

This keeps the scaffold small while matching the workflow language used by issue
trackers and planning boards:

- `Board` identifies the planning surface, tracker provider, and optional board ID.
- `CardAdapter` captures the Fizzy card number, title, target column ID, labels, and comment body.
- `Agent` remains the execution persona that would eventually process a card.

## Key Design Decisions

### 1. Dry-Run-First
All functionality in the initial scaffold is dry-run only. The `FizzyConfig.dry_run`
flag is `True` by default. Real subprocess execution can be layered on later
without changing the core model.

### 2. CLI-First Contract
The first real adapter is explicitly CLI-backed because Fizzy is purpose-built
for agent workflows. The command builder mirrors these commands:

- `fizzy card list`
- `fizzy card show NUMBER`
- `fizzy card column NUMBER --column COLUMN_ID`
- `fizzy comment create --card NUMBER --body TEXT`
- `fizzy doctor`

### 3. Pure Functions for Command Construction
`commands.py` contains only pure functions that accept domain objects and return
strings or lists of dicts. This makes the command-building logic trivially
testable without mocking any I/O.

### 4. Tracker-Native Vocabulary
The previous generic task/workflow vocabulary has been replaced with `Board` and
`CardAdapter` so the scaffold mirrors real tracker data more closely.

### 5. Board Context Resolution
The builder prefers an explicit `--board` value, but will fall back to `.fizzy.yaml`
when available. This matches the Fizzy skill guidance for board-scoped commands.

### 6. Standard-Library-Only Runtime
The package has **zero runtime dependencies** in the initial scaffold. This
maximises portability and keeps `pip install` fast. Optional extras (`[dev]`)
add `pytest` and `pytest-cov` for development use.

### 7. `src/` Layout
The package is placed under `src/fizzy_symphony/` following the
[src-layout](https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/)
convention, which prevents accidental imports from the project root during
development.

## Supporting Artifacts

| Path | Purpose |
|---|---|
| `examples/github_project_board.py` | Minimal board/card adapter example |
| `prompts/card-adapter-prompt.txt` | Reusable prompt template for a CLI-backed card adapter |
| `docs/roadmap.md` | Board-first milestones for the scaffold |
