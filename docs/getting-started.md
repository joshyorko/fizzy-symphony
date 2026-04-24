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
# === Fizzy Symphony — Dry-Run Execution Plan ===
# ...
# (dry-run mode — no commands were executed)
```

## Step 4 — Run the Tests

```bash
python -m compileall src        # syntax check
python -m pytest                # full test suite
```

All tests should pass.

## Step 5 — Explore the Code

The main package lives in `src/fizzy_symphony/`:

| File | Purpose |
|---|---|
| `models.py` | `Agent`, `Task`, `Workflow`, `FizzyConfig` dataclasses |
| `commands.py` | Pure functions that build Fizzy command strings |
| `cli.py` | `fizzy-symphony` CLI entry point |

## Step 6 — Write Your First Workflow (API)

```python
from fizzy_symphony import Agent, Task, Workflow, FizzyConfig
from fizzy_symphony import build_workflow_plan
from fizzy_symphony.commands import format_plan_as_text

agent = Agent(name="my-agent", model="gpt-4o")

task1 = Task(task_id="scaffold", description="Create project structure.", agent=agent)
task2 = Task(
    task_id="implement",
    description="Implement the core logic.",
    agent=agent,
    depends_on=["scaffold"],
)

workflow = Workflow(name="my-first-workflow", tasks=[task1, task2])
config = FizzyConfig(dry_run=True)

plan = build_workflow_plan(workflow, config)
print(format_plan_as_text(plan))
```

## Next Steps

- Read the [Architecture Guide](architecture.md) to understand the layered design.
- Check the `tests/` directory for examples of how to test models and commands.
- Watch the [Roadmap](../README.md#roadmap) for upcoming features.
