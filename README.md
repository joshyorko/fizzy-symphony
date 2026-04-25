# fizzy-symphony

> Fizzy-backed board orchestration for Codex coding agents.

---

## Overview

**Fizzy Symphony** is a Python scaffold for planning card-based automation on top
of [Fizzy](https://github.com/fizzy-project/fizzy). The scaffold treats **Fizzy
as the tracker and board system**, normalizes cards into a canonical `FizzyCard`
shape, and keeps tracker mutations dry-run-first while the durable queue layer
is delegated to `robocorp-adapters-custom`.

The design follows the original OpenAI Symphony model: an existing tracker board
is the human source of truth, one issue/card is claimed at a time, Codex works in
an isolated workspace, and proof is reported back to the same issue/card. The
main divergence is implementation plumbing: this project can use Robocorp
workitems as the durable claimed/running/result queue instead of keeping that
state only inside a long-running daemon.

It provides:

| Layer | Description |
|---|---|
| **Models** | Pure Python dataclasses (`FizzyCard`, `Agent`, `CardAdapter`, `Board`, `FizzyConfig`) |
| **Adapter** | A dry-run `FizzyCLIAdapter` that builds real Fizzy CLI commands without executing them |
| **CLI** | `fizzy-symphony` entry points for board bootstrap, setup checks, dry-run list/claim/comment/move flows, and a demo plan |
| **Workitems** | Robocorp-compatible queue payloads, adapter env helpers, and producer/worker/reporter helpers |

## Main Mapping

| Symphony concept | Fizzy Symphony concept |
| --- | --- |
| Issue tracker | Fizzy |
| Issue | Fizzy card |
| Project | Fizzy board |
| State | Fizzy list/column |
| Comment | Fizzy card comment/update |
| Orchestrator state | Robocorp workitem reservation/release/output state |
| Worker | Codex command/app-server session |
| Workflow contract | WORKFLOW.md |
| Workspace | Per-card branch/worktree |

> **Status:** Pre-alpha scaffold — no real Fizzy or Codex execution yet.
> The durable orchestration direction is now Robocorp workitems/RCC: Fizzy stays
> the board, workitems provide queue leasing/release, and Codex is the worker.

---

## Quick Start

```bash
# Install in editable mode (requires Python ≥ 3.9)
pip install -e ".[dev]"

# Optional: install Robocorp workitems adapter support
pip install -e ".[workitems]"

# Check how this checkout maps to the upstream Symphony model
fizzy-symphony doctor --board work-ai-board

# Print dry-run commands for preparing an existing Fizzy board
fizzy-symphony init-board --board work-ai-board

# Print default env JSON for robocorp-adapters-custom
fizzy-symphony workitems-env

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

### `fizzy-symphony doctor`

Prints a deterministic setup checklist and maps upstream OpenAI Symphony
concepts onto this Fizzy/RCC implementation.

```bash
fizzy-symphony doctor --board work-ai-board
```

### `fizzy-symphony init-board`

Prints dry-run commands for preparing an existing Fizzy board with the
recommended Symphony-style columns. It does not create a hidden system board by
default.

```bash
fizzy-symphony init-board --board work-ai-board
# fizzy column list --board work-ai-board --agent --quiet
# fizzy column create --board work-ai-board --name 'Ready for Agents' --agent --quiet
```

### `fizzy-symphony workitems-env`

Prints the default environment contract for the published
`robocorp-adapters-custom` package.

```bash
fizzy-symphony workitems-env
```

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
│       ├── robocorp_adapter.py     # Published adapter package loader/env contract
│       ├── symphony.py             # OpenAI Symphony concept mapping and board bootstrap
│       ├── tracker.py              # Tracker adapter contract
│       ├── workitem_pipeline.py    # Fizzy/workitems/Codex pipeline helpers
│       └── workitem_queue.py       # Robocorp-compatible work item payload/queue seam
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
- `docs/openai-symphony-alignment.md` explains how this maps to the upstream OpenAI Symphony model.
- `docs/rcc-workitems.md` describes the RCC/workitems refactor path.

---

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for the current phased roadmap.

---

## License

MIT
