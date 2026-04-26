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
│   - Mirrors list/show/move/comment/assign    │
│   - Models claim as a composite preview      │
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

Tracker mutation remains dry-run-first. The CLI adapter mirrors real Fizzy CLI
commands for preview/debugging, but it never executes subprocesses:

- `fizzy card list`
- `fizzy card show NUMBER`
- `fizzy card assign NUMBER --user USER_ID`
- `fizzy card self-assign NUMBER`
- `fizzy card column NUMBER --column COLUMN_ID`
- `fizzy comment create --card NUMBER --body TEXT`
- `fizzy doctor`

Claim is a `fizzy-symphony` semantic operation composed from the native tracker
steps above, not a required native `fizzy card claim` command.

## Key Design Decisions

### 1. Dry-Run-First
Tracker-facing CLI functionality is dry-run only. `FizzyCLIAdapter` raises if
configured for non-dry-run use so preview flows cannot accidentally execute real
tracker mutations. Runner and RCC smoke entry points are separate guarded
execution paths.

### 2. Canonical Card Shape
`FizzyCard` is the normalized tracker model. It keeps both the internal `id` and
human-facing `number` because Fizzy CLI commands operate on card numbers.

### 3. Explicit Tracker Contract
`tracker.py` defines the minimal adapter contract needed for later dispatch and
integration work: fetch cards, reconcile by internal IDs, operate on visible
card numbers, and expose `claim_card(...)` as an orchestration-level composite.

### 4. Compatibility Without Blocking Progress
`Board`, `CardAdapter`, and the compatibility command builders remain available
so the existing demo scaffold and examples still work while Phase 1 introduces a
more adapter-centric architecture.

### 5. Explicit Real-Adapter Path
`fizzy_symphony.adapters.fizzy_openapi` is a non-executing stub that documents
the future Python adapter path: `basecamp/fizzy-sdk/openapi.json` is the source
of truth because the official SDK repo does not currently ship a Python SDK.

### 6. Standard-Library-Only Runtime
The package has zero runtime dependencies. Optional extras (`[dev]`) add pytest
and pytest-cov for development.
