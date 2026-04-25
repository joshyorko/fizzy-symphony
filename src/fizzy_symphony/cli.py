"""Fizzy Symphony — Fizzy-backed board orchestration for Codex coding agents."""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

from . import __version__
from .adapters.fizzy_cli import FizzyCLIAdapter
from .commands import build_board_plan, format_plan_as_text
from .models import Agent, Board, CardAdapter, FizzyConfig
from .robocorp_adapter import (
    RobocorpWorkitemConfig,
    adapter_package_available,
    format_workitem_env,
)
from .symphony import format_init_board_plan, format_mapping_table


def _build_demo_board() -> Board:
    """Return a hard-coded demonstration board (no file I/O required)."""
    agent = Agent(name="codex-agent", model="gpt-4o", capabilities=[], max_tokens=4096, temperature=0.2)

    intake_card = CardAdapter(
        number=42,
        title="Capture the board request and draft a scoped implementation prompt.",
        agent=agent,
        column_id="ready-for-agents",
        labels=["board", "planning"],
        comment_body="Captured the request in dry-run mode and prepared the adapter prompt.",
    )
    adapter_card = CardAdapter(
        number=57,
        title="Map the tracker card into the Fizzy card adapter model.",
        agent=agent,
        column_id="synthesize-and-verify",
        labels=["adapter", "modeling"],
        comment_body="Mapped the tracker card into the canonical Fizzy card fields.",
    )
    verify_card = CardAdapter(
        number=61,
        title="Review the dry-run board plan output and update docs/tests.",
        agent=agent,
        column_id="ready-to-ship",
        labels=["docs", "tests"],
        comment_body="Validated the dry-run CLI contract and documented the setup guidance.",
    )

    return Board(
        name="work-ai-board",
        tracker="fizzy",
        board_id="work-ai-board",
        description="A demonstration board used by the dry-run adapter scaffold.",
        cards=[intake_card, adapter_card, verify_card],
    )


def _config_from_args(args: argparse.Namespace) -> FizzyConfig:
    return FizzyConfig(
        fizzy_bin=getattr(args, "fizzy_bin", "fizzy"),
        workspace=getattr(args, "workspace", "/tmp/fizzy-workspace"),
        board=getattr(args, "board", None),
        dry_run=True,
        timeout_seconds=getattr(args, "timeout", 300),
    )


def _print_dry_run_command(command: str) -> int:
    print(command)
    print("(dry-run mode — no commands were executed)")
    return 0


def _cmd_version(args: argparse.Namespace) -> int:  # noqa: ARG001
    """Print the package version and exit."""
    print(f"fizzy-symphony {__version__}")
    return 0


def _cmd_plan(args: argparse.Namespace) -> int:
    """Print the dry-run execution plan for a board."""
    config = _config_from_args(args)
    board = _build_demo_board()
    plan = build_board_plan(board, config)
    print(format_plan_as_text(plan))
    print("(dry-run mode — no commands were executed)")
    return 0


def _cmd_doctor(args: argparse.Namespace) -> int:
    """Print a deterministic readiness checklist for the local integration."""
    config = _config_from_args(args)
    adapter_status = "available" if adapter_package_available() else "missing"
    board = args.board or "FIZZY_BOARD / .fizzy.yaml"

    print("Fizzy Symphony Doctor")
    print("")
    print(f"Fizzy CLI check : {FizzyCLIAdapter(config=config).build_doctor_command()}")
    print(f"Board context   : {board}")
    print(f"Adapter package : robocorp-adapters-custom ({adapter_status})")
    print("Adapter role    : durable queue plumbing only")
    print("Orchestrator    : fizzy-symphony owns Symphony semantics")
    print("")
    print(format_mapping_table())
    return 0


def _cmd_init_board(args: argparse.Namespace) -> int:
    """Print dry-run commands for preparing an existing Fizzy board."""
    print(format_init_board_plan(args.board, fizzy_bin=args.fizzy_bin))
    print("")
    print("(dry-run mode — create only the columns that are missing)")
    return 0


def _cmd_workitems_env(args: argparse.Namespace) -> int:
    """Print default environment variables for the published adapter package."""
    config = RobocorpWorkitemConfig(
        adapter=args.adapter,
        queue_name=args.queue_name,
        output_queue_name=args.output_queue_name,
        db_path=args.db_path,
        files_dir=args.files_dir,
    )
    print(format_workitem_env(config))
    return 0


def _cmd_list(args: argparse.Namespace) -> int:
    adapter = FizzyCLIAdapter(config=_config_from_args(args))
    return _print_dry_run_command(adapter.build_list_command(args.board))


def _cmd_claim(args: argparse.Namespace) -> int:
    adapter = FizzyCLIAdapter(config=_config_from_args(args))
    return _print_dry_run_command(adapter.build_claim_command(args.card_number, args.board))


def _cmd_comment(args: argparse.Namespace) -> int:
    adapter = FizzyCLIAdapter(config=_config_from_args(args))
    return _print_dry_run_command(adapter.build_comment_command(args.card_number, args.body))


def _cmd_move(args: argparse.Namespace) -> int:
    adapter = FizzyCLIAdapter(config=_config_from_args(args))
    return _print_dry_run_command(adapter.build_move_command(args.card_number, args.column))


def _add_common_command_options(parser: argparse.ArgumentParser, *, include_board: bool = False) -> None:
    parser.add_argument(
        "--fizzy-bin",
        default="fizzy",
        metavar="PATH",
        help="Path or name of the fizzy executable (default: fizzy).",
    )
    parser.add_argument(
        "--workspace",
        default="/tmp/fizzy-workspace",
        metavar="DIR",
        help="Working directory for Fizzy jobs (default: /tmp/fizzy-workspace).",
    )
    if include_board:
        parser.add_argument(
            "--board",
            required=True,
            metavar="BOARD",
            help="Fizzy board identifier used when building the dry-run command.",
        )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Accepted for explicitness; dry-run is the only supported mode today.",
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fizzy-symphony",
        description="Fizzy-backed board orchestration for Codex coding agents.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")

    sub = parser.add_subparsers(dest="command", metavar="<command>")
    sub.required = True

    sub.add_parser("version", help="Print the package version.")

    plan_p = sub.add_parser("plan", help="Display the dry-run execution plan for a tracker board.")
    _add_common_command_options(plan_p)
    plan_p.add_argument(
        "--board",
        metavar="BOARD_ID",
        help="Explicit Fizzy board ID; otherwise the demo board ID is used.",
    )
    plan_p.add_argument(
        "--timeout",
        type=int,
        default=300,
        metavar="SECONDS",
        help="Reserved per-card timeout in seconds for future execution support (default: 300).",
    )

    doctor_p = sub.add_parser(
        "doctor",
        help="Print setup checks and the upstream Symphony mapping.",
    )
    _add_common_command_options(doctor_p)
    doctor_p.add_argument(
        "--board",
        metavar="BOARD_ID",
        help="Fizzy board ID to validate conceptually; otherwise use FIZZY_BOARD/.fizzy.yaml.",
    )

    init_p = sub.add_parser(
        "init-board",
        help="Print dry-run commands for preparing an existing Fizzy board.",
    )
    _add_common_command_options(init_p, include_board=True)

    env_p = sub.add_parser(
        "workitems-env",
        help="Print default robocorp-adapters-custom environment variables.",
    )
    env_p.add_argument(
        "--adapter",
        default=RobocorpWorkitemConfig.adapter,
        help="Fully qualified adapter class path.",
    )
    env_p.add_argument(
        "--queue-name",
        default=RobocorpWorkitemConfig.queue_name,
        help="Input queue name used by producer/worker.",
    )
    env_p.add_argument(
        "--output-queue-name",
        default=RobocorpWorkitemConfig.output_queue_name,
        help="Output queue name used by worker/reporter.",
    )
    env_p.add_argument(
        "--db-path",
        default=RobocorpWorkitemConfig.db_path,
        help="SQLite database path for local development.",
    )
    env_p.add_argument(
        "--files-dir",
        default=RobocorpWorkitemConfig.files_dir,
        help="Attachment directory for local development.",
    )

    list_p = sub.add_parser("list", help="Print the Fizzy CLI command for listing cards on a board.")
    _add_common_command_options(list_p, include_board=True)

    claim_p = sub.add_parser("claim", help="Print the Fizzy CLI command for claiming a card.")
    claim_p.add_argument("card_number", type=int, metavar="CARD_NUMBER", help="Visible Fizzy card number.")
    _add_common_command_options(claim_p, include_board=True)

    comment_p = sub.add_parser("comment", help="Print the Fizzy CLI command for commenting on a card.")
    comment_p.add_argument("card_number", type=int, metavar="CARD_NUMBER", help="Visible Fizzy card number.")
    comment_p.add_argument("--body", required=True, help="Comment body to pass to the Fizzy CLI.")
    _add_common_command_options(comment_p)

    move_p = sub.add_parser("move", help="Print the Fizzy CLI command for moving a card to a column.")
    move_p.add_argument("card_number", type=int, metavar="CARD_NUMBER", help="Visible Fizzy card number.")
    move_p.add_argument("--column", required=True, metavar="COLUMN_ID", help="Target Fizzy column identifier.")
    _add_common_command_options(move_p)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    """Parse arguments and dispatch to the appropriate sub-command."""
    parser = _build_parser()
    args = parser.parse_args(argv)

    dispatch = {
        "version": _cmd_version,
        "plan": _cmd_plan,
        "doctor": _cmd_doctor,
        "init-board": _cmd_init_board,
        "workitems-env": _cmd_workitems_env,
        "list": _cmd_list,
        "claim": _cmd_claim,
        "comment": _cmd_comment,
        "move": _cmd_move,
    }

    handler = dispatch.get(args.command)
    if handler is None:
        parser.print_help()
        return 1

    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
