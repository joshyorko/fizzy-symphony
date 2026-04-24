# fizzy-symphony

> Fizzy-backed board orchestration for Codex coding agents.

---

## Overview

**Fizzy Symphony** is a Python scaffold for planning card-based automation on top
of [Fizzy](https://github.com/fizzy-project/fizzy). The scaffold treats **Fizzy
as the tracker and board system**, normalizes cards into a canonical `FizzyCard`
shape, and keeps all adapter behavior dry-run only for now.

It provides:

| Layer | Description |
|---|---|
| **Models** | Pure Python dataclasses (`FizzyCard`, `Agent`, `CardAdapter`, `Board`, `FizzyConfig`) |
| **Adapter** | A dry-run `FizzyCLIAdapter` that builds real Fizzy CLI commands without executing them |
| **CLI** | `fizzy-symphony` entry points for dry-run list/claim/comment/move flows and a demo plan |

## Main Mapping

| Symphony concept | Fizzy Symphony concept |
| --- | --- |
| Issue tracker | Fizzy |
| Issue | Fizzy card |
| Project | Fizzy board |
| State | Fizzy list/column |
| Comment | Fizzy card comment/update |
| Worker | Codex app-server session |
| Workflow contract | WORKFLOW.md |
| Workspace | Per-card branch/worktree |

> **Status:** Pre-alpha scaffold — no real Fizzy or Codex execution yet.

---

## Quick Start

```bash
# Install in editable mode (requires Python ≥ 3.9)
pip install -e ".[dev]"

# Print the dry-run Fizzy command for listing a board
fizzy-symphony list --board work-ai-board --dry-run

# Claim a card in dry-run mode
fizzy-symphony claim 42 --board work-ai-board --dry-run

# Comment on a card in dry-run mode
fizzy-symphony comment 42 --body "Validated the change." --dry-run

# Move a card in dry-run mode
fizzy-symphony move 42 --column ready-to-ship --dry-run
```

---

## Installation

```bash
git clone https://github.com/joshyorko/fizzy-symphony.git
cd fizzy-symphony
pip install -e ".[dev]"
```

---

## CLI Commands

### `fizzy-symphony list`

Prints the Fizzy CLI command that would list cards for a board.

```bash
fizzy-symphony list --board work-ai-board --dry-run
# fizzy card list --board work-ai-board --agent --markdown
```

### `fizzy-symphony claim`

Prints the Fizzy CLI command that would claim exactly one visible card number.

```bash
fizzy-symphony claim 42 --board work-ai-board --dry-run
# fizzy card claim 42 --board work-ai-board --agent --quiet
```

### `fizzy-symphony comment`

Prints the Fizzy CLI command that would add a card comment/update.

```bash
fizzy-symphony comment 42 --body "Proof of work attached." --dry-run
# fizzy comment create --card 42 --body 'Proof of work attached.' --agent --quiet
```

### `fizzy-symphony move`

Prints the Fizzy CLI command that would move a card to a new column.

```bash
fizzy-symphony move 42 --column ready-to-ship --dry-run
# fizzy card column 42 --column ready-to-ship --agent --quiet
```

### `fizzy-symphony plan`

Displays a demonstration dry-run board plan using the same adapter-backed
command builders.

### `fizzy-symphony version`

Prints the installed package version.

---

## Project Layout

```text
fizzy-symphony/
├── docs/                           # Documentation
│   ├── architecture.md
│   ├── getting-started.md
│   └── roadmap.md
├── prompts/                        # Prompt templates for leads and workers
│   ├── card-adapter-prompt.txt
│   ├── program-lead.md
│   └── worker-agent.md
├── src/
│   └── fizzy_symphony/
│       ├── adapters/
│       │   └── fizzy_cli.py        # Dry-run Fizzy CLI adapter
│       ├── __init__.py
│       ├── cli.py                  # CLI entry point
│       ├── commands.py             # Compatibility wrappers over the adapter
│       ├── models.py               # FizzyCard, Agent, CardAdapter, Board, FizzyConfig
│       └── tracker.py              # Tracker adapter contract
├── tests/
│   ├── test_adapters_fizzy_cli.py
│   ├── test_cli.py
│   ├── test_commands.py
│   └── test_models.py
├── SPEC.md
├── WORKFLOW.example.md
├── pyproject.toml
└── README.md
```

---

## Development

```bash
python -m pip install -e ".[dev]"
python -m compileall src
python -m pytest
```

---

## Specs, Workflow, and Prompts

- `SPEC.md` describes the canonical domain model, tracker contract, workflow states, and safety invariants.
- `WORKFLOW.example.md` shows a board/workspace/agent configuration and a worker prompt body.
- `prompts/program-lead.md` guides the lead agent on board coordination and state transitions.
- `prompts/worker-agent.md` guides a worker to claim exactly one card, stay within allowed paths, and report proof of work.

---

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for the current phased roadmap.

---

## License

MIT
