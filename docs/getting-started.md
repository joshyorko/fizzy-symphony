# Getting Started with Fizzy Symphony

## Prerequisites

- Python 3.9 or later
- `pip` (comes with Python)
- Git

## Step 1 — Clone the Repository

```bash
git clone https://github.com/joshyorko/fizzy-symphony.git
cd fizzy-symphony
```

## Step 2 — Install in Editable Mode

Installing with the `dev` extra pulls in `pytest` for running the test suite.

```bash
pip install -e ".[dev]"
```

## Step 3 — Verify the Installation

```bash
fizzy-symphony version
# fizzy-symphony 0.1.0

fizzy-symphony plan
# === Fizzy Symphony — Dry-Run Board Plan ===
# Setup check  : fizzy doctor
# ...
# (dry-run mode — no commands were executed)
```

## Step 4 — Run the Tests

```bash
python -m compileall src
python -m pytest
```

All tests should pass.

## Step 5 — Explore the Code

The main package lives in `src/fizzy_symphony/`:

| File | Purpose |
|---|---|
| `models.py` | `Agent`, `CardAdapter`, `Board`, `FizzyConfig` dataclasses |
| `commands.py` | Pure functions that build dry-run Fizzy CLI commands |
| `cli.py` | `fizzy-symphony` CLI entry point |

## Step 6 — Build Your First Board (API)

```python
from fizzy_symphony import Agent, Board, CardAdapter, FizzyConfig, build_board_plan
from fizzy_symphony.commands import format_plan_as_text

agent = Agent(name="my-agent", model="gpt-4o")

board = Board(
    name="my-first-board",
    tracker="agent-skills/fizzy",
    board_id="03myboard",
    cards=[
        CardAdapter(
            number=42,
            title="Review the incoming request and summarize the scope.",
            column_id="triage",
            labels=["planning"],
            agent=agent,
            comment_body="Summarized the scope and prepared the next CLI-backed step.",
        ),
        CardAdapter(
            number=57,
            title="Translate the tracker card into a dry-run implementation prompt.",
            column_id="ready",
            labels=["adapter"],
            agent=agent,
            comment_body="Drafted the next implementation note for the card.",
        ),
    ],
)
config = FizzyConfig(dry_run=True)

plan = build_board_plan(board, config)
print(format_plan_as_text(plan))
```

## Step 7 — Reuse the Prompt Template

The scaffold includes `prompts/card-adapter-prompt.txt` for adapting tracker
metadata into the board/card language used by the CLI and docs.

## Step 8 — Match the Fizzy Skill Contract

The scaffold intentionally mirrors the `agent-skills` Fizzy skill and its
recommended commands:

```bash
fizzy doctor
fizzy card list --board BOARD_ID --agent --markdown
fizzy card show NUMBER --agent --markdown
fizzy card assign NUMBER --user USER_ID --agent --quiet
fizzy card self-assign NUMBER --agent --quiet
fizzy card column NUMBER --column COLUMN_ID --agent --quiet
fizzy comment create --card NUMBER --body "TEXT" --agent --quiet
```

If a repo already has `.fizzy.yaml`, the board plan can omit `--board`.

`fizzy-symphony claim` previews a composite orchestration claim using those
native commands. Assignment is optional for MVP; moving the card to the in-flight
column and leaving a worker-identity comment is sufficient.

## Next Steps

- Read the [Architecture Guide](architecture.md) to understand the layered design.
- Run `python examples/github_project_board.py` for a complete example.
- Review the [Roadmap](roadmap.md) for the next board-first milestones.
