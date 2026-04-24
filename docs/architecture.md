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
│   - build_agent_command()                    │
│   - build_workflow_plan()                    │
│   - format_plan_as_text()                    │
│   - Pure functions; no I/O or subprocesses   │
└──────────────────────┬──────────────────────┘
                       │ uses
┌──────────────────────▼──────────────────────┐
│               Domain Model Layer             │
│       fizzy_symphony.models (models.py)      │
│   - Agent, Task, Workflow, FizzyConfig       │
│   - Python dataclasses with validation       │
│   - No external dependencies                 │
└─────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. Dry-Run-First
All functionality in the initial scaffold is dry-run only.  The `FizzyConfig.dry_run`
flag is `True` by default.  Real subprocess execution will be added behind a
`--no-dry-run` CLI flag in a future milestone.

### 2. Pure Functions for Command Construction
`commands.py` contains only pure functions that accept domain objects and return
strings or lists of dicts.  This makes the command-building logic trivially
testable without mocking any I/O.

### 3. Standard-Library-Only Runtime
The package has **zero runtime dependencies** in the initial scaffold.  This
maximises portability and keeps `pip install` fast.  Optional extras (`[dev]`)
add `pytest` and `pytest-cov` for development use.

### 4. `src/` Layout
The package is placed under `src/fizzy_symphony/` following the
[src-layout](https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/)
convention, which prevents accidental imports from the project root during
development.

## Future Components

| Component | Description |
|---|---|
| `loader.py` | YAML/JSON workflow file parser |
| `executor.py` | Real Fizzy subprocess execution |
| `codex_client.py` | OpenAI Codex API client |
| `scheduler.py` | Dependency-aware parallel task scheduler |
| `reporter.py` | Rich terminal progress reporting |
