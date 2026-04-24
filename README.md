# fizzy-symphony

> Fizzy-backed board orchestration for Codex coding agents.

---

## Overview

**Fizzy Symphony** is a Python scaffold for planning card-based automation on top
of [Fizzy](https://github.com/fizzy-project/fizzy). The revised scaffold models
Fizzy as a board/tracker and adapts tracker cards into dry-run-safe command
plans that mirror the `joshyorko/agent-skills` Fizzy skill CLI contract.

It provides:

| Layer | Description |
|---|---|
| **Models** | Pure Python dataclasses (`Agent`, `CardAdapter`, `Board`, `FizzyConfig`) |
| **Commands** | Functions that build dry-run Fizzy CLI commands (`card list/show/column`, `comment create`, `doctor`) |
| **CLI** | `fizzy-symphony` entry point for dry-run board plan display |

> **Status:** Pre-alpha scaffold — no real Fizzy or Codex execution yet.

---

## Quick Start

```bash
# Install in editable mode (requires Python ≥ 3.9)
pip install -e ".[dev]"

# Show a dry-run board plan
fizzy-symphony plan

# Print version
fizzy-symphony version
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

### `fizzy-symphony plan`

Prints the dry-run execution plan for a tracker board.

```
usage: fizzy-symphony plan [-h] [--fizzy-bin PATH] [--workspace DIR] [--board BOARD_ID] [--timeout SECONDS]

options:
  --fizzy-bin PATH    Path or name of the fizzy executable (default: fizzy)
  --workspace DIR     Working directory for Fizzy jobs (default: /tmp/fizzy-workspace)
  --board BOARD_ID    Explicit Fizzy board ID; otherwise .fizzy.yaml board context is used when available.
  --timeout SECONDS   Reserved per-card timeout in seconds for future execution support (default: 300)
```

Example output:

```
=== Fizzy Symphony — Dry-Run Board Plan ===

Setup check  : fizzy doctor
Board ctx    : 03foq1hqmyy91tuyz3ghugg6c

Card 1: [#42]
  Title          : Capture the board request and draft a scoped implementation prompt.
  Agent          : codex-agent
  Board          : fizzy-scaffold
  Tracker        : agent-skills/fizzy
  Column ID      : triage
  List command   : fizzy card list --board 03foq1hqmyy91tuyz3ghugg6c --agent --markdown
  Show command   : fizzy card show 42 --agent --markdown
  Move command   : fizzy card column 42 --column triage --agent --quiet
  Comment command: fizzy comment create --card 42 --body 'Captured the request in dry-run mode and prepared the adapter prompt.' --agent --quiet

(dry-run mode — no commands were executed)
```

### `fizzy-symphony version`

Prints the installed package version.

---

## Project Layout

```
fizzy-symphony/
├── docs/                   # Documentation
│   ├── architecture.md
│   ├── getting-started.md
│   └── roadmap.md
├── examples/               # Python examples for the board/card scaffold
├── prompts/                # Reusable prompt templates for card adapters
├── src/
│   └── fizzy_symphony/     # Python package
│       ├── __init__.py
│       ├── models.py       # Agent, CardAdapter, Board, FizzyConfig
│       ├── commands.py     # Command construction (dry-run safe)
│       └── cli.py          # CLI entry point
├── tests/
│   ├── test_cli.py
│   ├── test_commands.py
│   └── test_models.py
├── pyproject.toml
└── README.md
```

---

## Development

```bash
# Run all tests
python -m pytest

# Compile-check the package
python -m compileall src

# Run with coverage
python -m pytest --cov=fizzy_symphony
```

---

## Examples and Prompts

- `examples/github_project_board.py` shows the revised Python scaffold in code.
- `prompts/card-adapter-prompt.txt` provides a reusable prompt template for tracker cards.
- The dry-run builder follows the `agent-skills` Fizzy CLI contract: `fizzy card list`, `fizzy card show NUMBER`, `fizzy card column NUMBER --column COLUMN_ID`, `fizzy comment create --card NUMBER --body TEXT`.
- Prefer built-in `--markdown`, `--agent`, `--quiet`, and `--jq` over shell pipes, and use `fizzy doctor` for setup/config/auth checks.

---

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for the board-first roadmap.

---

## License

MIT
