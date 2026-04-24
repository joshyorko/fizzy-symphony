"""
CLI entry point for Fizzy Symphony.

All commands are dry-run only in this initial scaffold — no real Fizzy
or Codex subprocesses are spawned.

Usage examples (after ``pip install -e .``):

    fizzy-symphony plan    --workflow examples/hello_world.yaml
    fizzy-symphony version
"""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from . import __version__
from .commands import build_workflow_plan, format_plan_as_text
from .models import Agent, FizzyConfig, Task, Workflow


# ---------------------------------------------------------------------------
# Demo workflow builder
# ---------------------------------------------------------------------------

def _build_demo_workflow() -> Workflow:
    """Return a hard-coded demonstration workflow (no file I/O required)."""
    agent = Agent(
        name="codex-agent",
        model="gpt-4o",
        capabilities=[],
        max_tokens=4096,
        temperature=0.2,
    )

    scaffold_task = Task(
        task_id="scaffold-project",
        description="Create the initial project structure and boilerplate files.",
        agent=agent,
    )
    implement_task = Task(
        task_id="implement-core",
        description="Implement the core orchestration logic.",
        agent=agent,
        depends_on=["scaffold-project"],
    )
    test_task = Task(
        task_id="write-tests",
        description="Write unit tests for all public APIs.",
        agent=agent,
        depends_on=["implement-core"],
    )

    workflow = Workflow(
        name="demo-workflow",
        description="A demonstration workflow used by the CLI dry-run.",
        tasks=[scaffold_task, implement_task, test_task],
    )
    return workflow


# ---------------------------------------------------------------------------
# Sub-command handlers
# ---------------------------------------------------------------------------

def _cmd_version(args: argparse.Namespace) -> int:  # noqa: ARG001
    """Print the package version and exit."""
    print(f"fizzy-symphony {__version__}")
    return 0


def _cmd_plan(args: argparse.Namespace) -> int:
    """Print the dry-run execution plan for a workflow."""
    config = FizzyConfig(
        fizzy_bin=args.fizzy_bin,
        workspace=args.workspace,
        dry_run=True,
        timeout_seconds=args.timeout,
    )

    # In this scaffold, we always use the built-in demo workflow.
    workflow = _build_demo_workflow()

    plan = build_workflow_plan(workflow, config)
    print(format_plan_as_text(plan))

    print("(dry-run mode — no commands were executed)")
    return 0


# ---------------------------------------------------------------------------
# Argument parser
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fizzy-symphony",
        description="Fizzy-backed Symphony-style orchestration for Codex coding agents.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )

    sub = parser.add_subparsers(dest="command", metavar="<command>")
    sub.required = True

    # version sub-command
    sub.add_parser("version", help="Print the package version.")

    # plan sub-command
    plan_p = sub.add_parser(
        "plan",
        help="Display the dry-run execution plan for a workflow.",
    )
    plan_p.add_argument(
        "--fizzy-bin",
        default="fizzy",
        metavar="PATH",
        help="Path or name of the fizzy executable (default: fizzy).",
    )
    plan_p.add_argument(
        "--workspace",
        default="/tmp/fizzy-workspace",
        metavar="DIR",
        help="Working directory for Fizzy jobs (default: /tmp/fizzy-workspace).",
    )
    plan_p.add_argument(
        "--timeout",
        type=int,
        default=300,
        metavar="SECONDS",
        help="Per-task timeout in seconds (default: 300).",
    )

    return parser


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv: Optional[List[str]] = None) -> int:
    """Parse arguments and dispatch to the appropriate sub-command.

    Args:
        argv: Argument list (defaults to ``sys.argv[1:]``).

    Returns:
        Exit code (``0`` on success, non-zero on failure).
    """
    parser = _build_parser()
    args = parser.parse_args(argv)

    dispatch = {
        "version": _cmd_version,
        "plan": _cmd_plan,
    }

    handler = dispatch.get(args.command)
    if handler is None:
        parser.print_help()
        return 1

    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
