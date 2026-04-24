"""
Command construction for Fizzy Symphony.

All public functions in this module **build** command strings or plan
descriptions — they never execute subprocesses.  Real Fizzy and Codex
execution is out-of-scope for this initial scaffold.
"""

from __future__ import annotations

from typing import Dict, List

from .models import Agent, FizzyConfig, Task, Workflow


def build_agent_command(
    agent: Agent,
    task: Task,
    config: FizzyConfig,
) -> str:
    """Build the Fizzy shell command for a single agent/task pair.

    The resulting string is suitable for display (dry-run) or later
    subprocess execution.  The function itself never spawns a process.

    Args:
        agent: The :class:`~fizzy_symphony.models.Agent` that will run the task.
        task: The :class:`~fizzy_symphony.models.Task` to be executed.
        config: :class:`~fizzy_symphony.models.FizzyConfig` with runtime options.

    Returns:
        A shell command string, e.g.::

            fizzy run --model gpt-4o --max-tokens 4096 --temperature 0.2
                      --workspace /tmp/fizzy-workspace --timeout 300
                      --task-id generate-tests
                      --prompt "Write unit tests for the auth module"
    """
    parts: List[str] = [config.fizzy_bin, "run"]

    parts += ["--model", agent.model]
    parts += ["--max-tokens", str(agent.max_tokens)]
    parts += ["--temperature", str(agent.temperature)]
    parts += ["--workspace", config.workspace]
    parts += ["--timeout", str(config.timeout_seconds)]
    parts += ["--task-id", task.task_id]

    if task.prompt:
        parts += ["--prompt", f'"{task.prompt}"']
    else:
        parts += ["--prompt", f'"{task.description}"']

    if config.dry_run:
        parts += ["--dry-run"]

    parts.extend(config.extra_flags)

    return " ".join(parts)


def build_workflow_plan(
    workflow: Workflow,
    config: FizzyConfig,
) -> List[Dict[str, str]]:
    """Build a dry-run execution plan for an entire workflow.

    Each entry in the returned list is a mapping with the keys:

    ``task_id``
        The task identifier.
    ``description``
        Human-readable description of the task.
    ``agent``
        The agent name assigned to the task.
    ``command``
        The fully-constructed Fizzy command string (never executed).
    ``depends_on``
        Comma-separated list of prerequisite task IDs (empty string if none).

    Args:
        workflow: The :class:`~fizzy_symphony.models.Workflow` to plan.
        config: :class:`~fizzy_symphony.models.FizzyConfig` with runtime options.

    Returns:
        An ordered list of plan entry dicts, one per task.
    """
    plan: List[Dict[str, str]] = []
    for task in workflow.tasks:
        cmd = build_agent_command(task.agent, task, config)
        plan.append(
            {
                "task_id": task.task_id,
                "description": task.description,
                "agent": task.agent.name,
                "command": cmd,
                "depends_on": ", ".join(task.depends_on),
            }
        )
    return plan


def format_plan_as_text(plan: List[Dict[str, str]]) -> str:
    """Render a workflow plan (from :func:`build_workflow_plan`) as human-readable text.

    Args:
        plan: Output from :func:`build_workflow_plan`.

    Returns:
        A multi-line string suitable for printing to a terminal.
    """
    if not plan:
        return "(empty workflow — no tasks defined)"

    lines: List[str] = ["=== Fizzy Symphony — Dry-Run Execution Plan ===", ""]
    for i, entry in enumerate(plan, start=1):
        lines.append(f"Step {i}: [{entry['task_id']}]")
        lines.append(f"  Description : {entry['description']}")
        lines.append(f"  Agent       : {entry['agent']}")
        if entry["depends_on"]:
            lines.append(f"  Depends on  : {entry['depends_on']}")
        lines.append(f"  Command     : {entry['command']}")
        lines.append("")
    return "\n".join(lines)
