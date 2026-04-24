# Architecture

## Overview

Fizzy Symphony is structured in three layers:

```text
┌─────────────────────────────────────────────┐
│                   CLI Layer                  │
│         fizzy_symphony.cli  (cli.py)         │
│   - Argument parsing via argparse            │
│   - Sub-commands: list/claim/comment/move    │
│   - Demo plan and version commands           │
│   - Dry-run only; never spawns processes     │
└──────────────────────┬──────────────────────┘
                       │ calls
┌──────────────────────▼──────────────────────┐
│               Adapter Layer                  │
│  fizzy_symphony.adapters.fizzy_cli           │
│   - Builds Fizzy CLI command strings         │
│   - Mirrors list/claim/show/move/comment     │
│   - Enforces dry-run-only behavior           │
└──────────────────────┬──────────────────────┘
                       │ uses
┌──────────────────────▼──────────────────────┐
│               Domain Model Layer             │
│       fizzy_symphony.models / tracker        │
│   - FizzyCard, Agent, CardAdapter, Board     │
│   - TrackerAdapter protocol                  │
│   - Python dataclasses with validation       │
└─────────────────────────────────────────────┘
```

## Revised Scaffold Model

The scaffold treats **Fizzy as the tracker/board layer**. Tracker items are
normalized into `FizzyCard` objects, while `CardAdapter` remains a compatibility
wrapper for the existing demo board plan.

Phase 0 keeps the system dry-run only. The adapter mirrors real Fizzy CLI
commands, but it never executes subprocesses:

- `fizzy card list`
- `fizzy card claim NUMBER`
- `fizzy card show NUMBER`
- `fizzy card column NUMBER --column COLUMN_ID`
- `fizzy comment create --card NUMBER --body TEXT`
- `fizzy doctor`

## Key Design Decisions

### 1. Dry-Run-First
All functionality is dry-run only. `FizzyCLIAdapter` raises if configured for
non-dry-run use so Phase 0 cannot accidentally execute real tracker mutations.

### 2. Canonical Card Shape
`FizzyCard` is the normalized tracker model. It keeps both the internal `id` and
human-facing `number` because Fizzy CLI commands operate on card numbers.

### 3. Explicit Tracker Contract
`tracker.py` defines the minimal adapter contract needed for later dispatch and
integration work: fetch candidate cards, fetch cards by state, read states,
create comments, and update states.

### 4. Compatibility Without Blocking Progress
`Board`, `CardAdapter`, and the compatibility command builders remain available
so the existing demo scaffold and examples still work while Phase 1 introduces a
more adapter-centric architecture.

### 5. Standard-Library-Only Runtime
The package has zero runtime dependencies. Optional extras (`[dev]`) add pytest
and pytest-cov for development.
