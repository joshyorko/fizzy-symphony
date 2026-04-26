# fizzy-symphony

> Fizzy-backed board orchestration for Codex coding agents.

---

## Overview

**Fizzy Symphony** is a Python scaffold for planning card-based automation on top
of [Fizzy](https://github.com/basecamp/fizzy-cli). The scaffold treats **Fizzy
as the tracker and board system**, normalizes cards into a canonical `FizzyCard`
shape, and keeps tracker mutations dry-run-first while the durable queue layer
is delegated to `robocorp-adapters-custom`.

The design follows the original OpenAI Symphony model: an existing tracker board
is the human source of truth, one issue/card is claimed at a time, Codex works in
an isolated workspace, and proof is reported back to the same issue/card. The
main divergence is implementation plumbing: this project can use Robocorp
workitems as the durable claimed/running/result queue instead of keeping that
state only inside a long-running daemon.

The closest Fizzy-native prior art is Basecamp's reference implementation. This
repo borrows its golden-ticket board pattern, but keeps a separate Python/RCC
lane for larger asynchronous execution.

It provides:

| Layer | Description |
|---|---|
| **Models** | Pure Python dataclasses (`FizzyCard`, `GoldenTicket`, `Agent`, `CardAdapter`, `Board`, `FizzyConfig`) |
| **Adapter** | A dry-run `FizzyCLIAdapter` for command preview/debugging plus a future `FizzyOpenAPIAdapter` stub for real tracker reads/writes |
| **CLI** | `fizzy-symphony` entry points for board bootstrap, setup checks, dry-run list/claim/comment/move flows, and a demo plan |
| **Workitems** | Robocorp-compatible queue payloads, adapter env helpers, and producer/worker/reporter helpers |

## Operating Modes

Simple mode should stay clean:

```text
Fizzy board -> polling -> Codex -> comment/move card
```

Durable mode is the reason for this Python/RCC variant:

```text
Fizzy board -> producer -> workitem lease -> RCC/Codex worker -> reporter -> Fizzy
```

Fizzy stores the work truth: card content, comments, tags, visible lanes, and
proof. Workitems store execution custody: leases, retries, worker outputs,
artifacts, and reporter handoff. If durable mode does not provide real
multi-worker or crash-recovery value, operators should prefer the simpler
Basecamp reference implementation.

## Main Mapping

| Symphony concept | Fizzy Symphony concept |
| --- | --- |
| Issue tracker | Fizzy |
| Issue | Fizzy card |
| Project | Fizzy board |
| State | Fizzy system lane or custom column |
| Comment | Fizzy card comment/update |
| Orchestrator state | Robocorp workitem reservation/release/output state |
| Worker | Codex command/app-server session |
| Workflow contract | WORKFLOW.md |
| Workspace | Per-card branch/worktree |

> **Status:** Pre-alpha, but the runner and RCC smoke paths now execute.
> Tracker-facing CLI flows remain dry-run-first unless explicitly guarded as
> live smoke commands.

---

## Quick Start

```bash
# Install in editable mode (requires Python ≥ 3.9)
pip install -e ".[dev]"

# Optional: install Robocorp workitems adapter support
pip install -e ".[workitems]"

# Create local service config/env files
fizzy-symphony setup \
  --workspace "$PWD/tmp/rails-todo-live" \
  --prompt-file devdata/rails-todo.prompt.md \
  --board-name "Fizzy Symphony Rails Todo" \
  --card-title "Build a simple Rails todo app"

# Start the RCC-backed service in the foreground, or detach it
fizzy-symphony start
fizzy-symphony start --detach

# Inspect process, queue, board/card, and SDK status
fizzy-symphony status

# List Fizzy boards
fizzy-symphony boards

# Check how this checkout maps to the upstream Symphony model
fizzy-symphony doctor --board work-ai-board

# Print dry-run commands for preparing an existing Fizzy board
fizzy-symphony init-board --board work-ai-board

# Print default env JSON for robocorp-adapters-custom
fizzy-symphony workitems-env

# Print the dry-run Fizzy command for listing a board
fizzy-symphony list --board work-ai-board --dry-run

# Claim a card in dry-run mode
fizzy-symphony claim 42 --board work-ai-board --in-flight-column col_in_flight --dry-run

# Preview a composite claim with an explicit in-flight column/comment
fizzy-symphony claim 42 --in-flight-column col_in_flight --comment-body "Claimed by fizzy-symphony worker." --dry-run

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

### `fizzy-symphony setup/start/status/boards`

These are the normal operator commands. `setup` writes `.fizzy-symphony/config.json`
and `.fizzy-symphony/env.json`; `start` delegates to RCC using that env file;
`status` shows process, queue, latest board/card, and SDK metadata; `boards`
lists boards through the Fizzy CLI.

```bash
fizzy-symphony setup \
  --workspace "$PWD/tmp/rails-todo-live" \
  --prompt-file devdata/rails-todo.prompt.md \
  --board-name "Fizzy Symphony Rails Todo" \
  --card-title "Build a simple Rails todo app"

fizzy-symphony start --detach
fizzy-symphony status
fizzy-symphony boards
```

### `fizzy-symphony doctor`

Prints a deterministic setup checklist and maps upstream OpenAI Symphony
concepts onto this Fizzy/RCC implementation.

```bash
fizzy-symphony doctor --board work-ai-board
```

### `fizzy-symphony init-board`

Prints dry-run commands for preparing an existing Fizzy board with the
recommended Symphony-style custom columns. It does not create a hidden system
board by default, and it treats `Maybe?`, `Not Now`, and `Done` as built-in
Fizzy system lanes rather than custom columns to create.

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

Prints the composite dry-run commands that would claim exactly one visible card
number. Claim is a `fizzy-symphony` orchestration concept, not a native single
Fizzy CLI operation, so the preview is:

- show the card
- optionally assign/self-assign
- move the card to the in-flight column
- add a claim comment

```bash
fizzy-symphony claim 42 --board work-ai-board --in-flight-column col_in_flight --dry-run
# fizzy card show 42 --agent --markdown
# fizzy card column 42 --column col_in_flight --agent --quiet
# fizzy comment create --card 42 --body 'Claimed by fizzy-symphony worker.' --agent --quiet

fizzy-symphony claim 42 --self-assign --in-flight-column col_in_flight --dry-run
# fizzy card show 42 --agent --markdown
# fizzy card self-assign 42 --agent --quiet
# fizzy card column 42 --column col_in_flight --agent --quiet
# fizzy comment create --card 42 --body 'Claimed by fizzy-symphony worker.' --agent --quiet

fizzy-symphony claim 42 --assignee-id user-123 --in-flight-column col_ready --comment-body "Claimed by fizzy-symphony worker." --dry-run
# fizzy card show 42 --agent --markdown
# fizzy card assign 42 --user user-123 --agent --quiet
# fizzy card column 42 --column ready --agent --quiet
# fizzy comment create --card 42 --body 'Claimed by fizzy-symphony worker.' --agent --quiet
```

### `fizzy-symphony comment`

Prints the Fizzy CLI command that would add a card comment/update.

```bash
fizzy-symphony comment 42 --body "Proof of work attached." --dry-run
# fizzy comment create --card 42 --body 'Proof of work attached.' --agent --quiet
```

### `fizzy-symphony move`

Prints the Fizzy CLI command that would move a card to a custom column or Fizzy
system lane. Custom columns should be targeted by real column ID. The system
lanes are immutable pseudo lanes: `maybe`, `not-now`, and `done`.

```bash
fizzy-symphony move 42 --column ready-to-ship --dry-run
# fizzy card column 42 --column ready-to-ship --agent --quiet

fizzy-symphony move 42 --column maybe --dry-run
# fizzy card untriage 42 --agent --quiet

fizzy-symphony move 42 --column not-now --dry-run
# fizzy card postpone 42 --agent --quiet

fizzy-symphony move 42 --column done --dry-run
# fizzy card close 42 --agent --quiet

fizzy-symphony move 42 --column "Ready for Agents" \
  --custom-column "col_ready=Ready for Agents" --dry-run
# fizzy card column 42 --column col_ready --agent --quiet
```

Name-based custom-column resolution is only a convenience for mapped columns.
Duplicate custom column names are rejected; use column IDs when a board has
ambiguous display names.

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
├── robots/
│   └── workitems/                   # RCC SQLite smoke robot
├── src/
│   └── fizzy_symphony/
│       ├── adapters/
│       │   ├── fizzy_cli.py        # Dry-run Fizzy CLI adapter
│       │   └── fizzy_openapi.py    # Future OpenAPI-backed adapter stub
│       ├── __init__.py
│       ├── cli.py                  # CLI entry point
│       ├── commands.py             # Compatibility wrappers over the adapter
│       ├── models.py               # FizzyCard, Agent, CardAdapter, Board, FizzyConfig
│       ├── robocorp_adapter.py     # Published adapter package loader/env contract
│       ├── runners.py              # Codex runner boundary and CLI fallback
│       ├── symphony.py             # OpenAI Symphony concept mapping and board bootstrap
│       ├── tracker.py              # Tracker adapter contract
│       ├── workitem_pipeline.py    # Fizzy/workitems/Codex pipeline helpers
│       └── workitem_queue.py       # Robocorp-compatible work item payload/queue seam
├── tests/
│   ├── test_adapters_fizzy_cli.py
│   ├── test_cli.py
│   ├── test_commands.py
│   └── test_models.py
├── test-projects/
│   └── workai-smoke/                # Disposable Fizzy board + fake repo smoke harness
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

# Optional RCC smoke with SQLite workitems
rcc run -r robots/workitems/robot.yaml --dev -t SmokeSQLiteWorkitemFlow \
  -e robots/workitems/devdata/env-sqlite.json --silent
```

For a live visual Fizzy smoke board, create a disposable board and cards:

```bash
python test-projects/workai-smoke/bootstrap_board.py --live --create-board
```

---

## Specs, Workflow, and Prompts

- `SPEC.md` describes the canonical domain model, tracker contract, workflow states, and safety invariants.
- `WORKFLOW.example.md` shows a board/workspace/agent configuration and a worker prompt body.
- `prompts/program-lead.md` guides the lead agent on board coordination and state transitions.
- `prompts/worker-agent.md` guides a worker to claim exactly one card, stay within allowed paths, and report proof of work.
- `docs/openai-symphony-alignment.md` explains how this maps to the upstream OpenAI Symphony model.
- `docs/prior-art-basecamp-reference.md` compares this repo with Basecamp's Fizzy-native implementation.
- `docs/feature-parity-roadmap.md` tracks simple-mode and durable-mode parity work.
- `docs/codex-runner-strategy.md` explains why Codex SDK/app-server is the preferred worker harness.
- `docs/production-smoke-agent.md` defines the SDK-backed release smoke gate.
- `docs/live-operator-guide.md` walks from devcontainer setup to a live Fizzy card run.
- `docs/rcc-workitems.md` describes the RCC/workitems refactor path.
- `robots/workitems/` contains the RCC SQLite smoke robot.
- `test-projects/workai-smoke/` contains the disposable Fizzy board fixture and fake project.

## Adapter Strategy

- `FizzyCLIAdapter` is for dry-run command preview, debugging, and
  operator/agent workflows. It never executes subprocesses.
- `FizzyOpenAPIAdapter` is the explicit future real tracker adapter. The
  official SDK repo is `basecamp/fizzy-sdk`; it does not currently ship a
  Python SDK, so `openapi.json` is the source of truth for a future Python
  implementation.
- Robocorp workitems remain the durable queue, lease, retry, and result-handoff
  layer. Fizzy is still the human-visible tracker layer.
- Assignment is optional for MVP claim previews; a dedicated Codex/Fizzy
  Symphony user can be added later without blocking the orchestration loop.

## Runner Strategy

The runner boundary now lives in `fizzy_symphony.runners`. `CodexCliRunner`
is the safe subprocess fallback, `CodexSdkRunner` uses the official Codex
app-server protocol when the local runtime is available, and
`CodexWorkItemRunner` adapts the runner contract to durable workitems.

This project should not build its own coding-agent harness. For "let Codex work
a repo card," use Codex as the harness and keep `fizzy-symphony` focused on
Fizzy routing, durable work custody, and report-back.

---

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for the current phased roadmap.

---

## License

MIT
