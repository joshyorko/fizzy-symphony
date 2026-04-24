"""
CLI entry point for Fizzy Symphony.

All commands are dry-run only in this initial scaffold — no real Fizzy
or Codex subprocesses are spawned.

Usage examples (after ``pip install -e .``):

    fizzy-symphony plan
    fizzy-symphony version
"""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from . import __version__
from .commands import build_board_plan, format_plan_as_text
from .models import Agent, Board, CardAdapter, FizzyConfig


def _build_demo_board() -> Board:
    """Return a hard-coded demonstration board (no file I/O required)."""
    agent = Agent(
        name="codex-agent",
        model="gpt-4o",
        capabilities=[],
        max_tokens=4096,
        temperature=0.2,
    )

    intake_card = CardAdapter(
        number=42,
        title="Capture the board request and draft a scoped implementation prompt.",
        agent=agent,
        column_id="triage",
        labels=["board", "planning"],
        comment_body="Captured the request in dry-run mode and prepared the adapter prompt.",
    )
    adapter_card = CardAdapter(
        number=57,
        title="Map the tracker card into the Fizzy card adapter model.",
        agent=agent,
        column_id="ready",
        labels=["adapter", "modeling"],
        comment_body="Mapped the tracker card into the CLI-backed card adapter fields.",
    )
    verify_card = CardAdapter(
        number=61,
        title="Review the dry-run board plan output and update docs/tests.",
        agent=agent,
        column_id="in-progress",
        labels=["docs", "tests"],
        comment_body="Validated the dry-run CLI contract and documented the setup guidance.",
    )

    return Board(
        name="fizzy-scaffold",
        tracker="agent-skills/fizzy",
        board_id="03foq1hqmyy91tuyz3ghugg6c",
        description="A demonstration board used by the CLI dry-run.",
        cards=[intake_card, adapter_card, verify_card],
    )


def _cmd_version(args: argparse.Namespace) -> int:  # noqa: ARG001
    """Print the package version and exit."""
    print(f"fizzy-symphony {__version__}")
    return 0


def _cmd_plan(args: argparse.Namespace) -> int:
    """Print the dry-run execution plan for a board."""
    config = FizzyConfig(
        fizzy_bin=args.fizzy_bin,
        workspace=args.workspace,
        board=args.board,
        dry_run=True,
        timeout_seconds=args.timeout,
    )

    board = _build_demo_board()
    plan = build_board_plan(board, config)
    print(format_plan_as_text(plan))
    print("(dry-run mode — no commands were executed)")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fizzy-symphony",
        description="Fizzy-backed board orchestration for Codex coding agents.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )

    sub = parser.add_subparsers(dest="command", metavar="<command>")
    sub.required = True

    sub.add_parser("version", help="Print the package version.")

    plan_p = sub.add_parser(
        "plan",
        help="Display the dry-run execution plan for a tracker board.",
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
        "--board",
        metavar="BOARD_ID",
        help="Explicit Fizzy board ID; otherwise .fizzy.yaml board context is used when available.",
    )
    plan_p.add_argument(
        "--timeout",
        type=int,
        default=300,
        metavar="SECONDS",
        help="Reserved per-card timeout in seconds for future execution support (default: 300).",
    )

    return parser


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
