# fizzy-symphony

> Fizzy-backed Symphony-style orchestration for Codex coding agents.

---

## Overview

**Fizzy Symphony** is a Python framework for orchestrating [Codex](https://openai.com/blog/openai-codex) coding agents using [Fizzy](https://github.com/fizzy-project/fizzy) as the underlying execution engine.

It provides:

| Layer | Description |
|---|---|
| **Models** | Pure Python dataclasses (`Agent`, `Task`, `Workflow`, `FizzyConfig`) |
| **Commands** | Functions that *build* Fizzy shell commands without executing them |
| **CLI** | `fizzy-symphony` entry point for dry-run plan display |

> **Status:** Pre-alpha scaffold — no real Fizzy or Codex execution yet.

---

## Quick Start

```bash
# Install in editable mode (requires Python ≥ 3.9)
pip install -e ".[dev]"

# Show a dry-run execution plan
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

Prints the dry-run execution plan for a workflow.

```
usage: fizzy-symphony plan [-h] [--fizzy-bin PATH] [--workspace DIR] [--timeout SECONDS]

options:
  --fizzy-bin PATH    Path or name of the fizzy executable (default: fizzy)
  --workspace DIR     Working directory for Fizzy jobs (default: /tmp/fizzy-workspace)
  --timeout SECONDS   Per-task timeout in seconds (default: 300)
```

Example output:

```
=== Fizzy Symphony — Dry-Run Execution Plan ===

Step 1: [scaffold-project]
  Description : Create the initial project structure and boilerplate files.
  Agent       : codex-agent
  Command     : fizzy run --model gpt-4o --max-tokens 4096 --temperature 0.2 ...

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
│   └── getting-started.md
├── src/
│   └── fizzy_symphony/     # Python package
│       ├── __init__.py
│       ├── models.py       # Agent, Task, Workflow, FizzyConfig
│       ├── commands.py     # Command construction (dry-run safe)
│       └── cli.py          # CLI entry point
├── tests/
│   ├── test_models.py
│   └── test_commands.py
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

## Roadmap

- [ ] YAML workflow file loading
- [ ] Real Fizzy subprocess execution (behind `--no-dry-run` flag)
- [ ] OpenAI Codex API integration
- [ ] Parallel task execution with dependency resolution
- [ ] Rich terminal output
- [ ] GitHub Actions integration

---

## License

MIT
