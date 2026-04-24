"""
Command construction for Fizzy Symphony.

All public functions in this module **build** command strings or plan
descriptions — they never execute subprocesses. Phase 0 mirrors the real
Fizzy CLI contract while remaining dry-run only.
"""

from __future__ import annotations

from pathlib import Path
from shlex import quote
from typing import Dict, List

from .models import Agent, Board, CardAdapter, FizzyConfig


def _board_flag_parts(board: Board, config: FizzyConfig) -> List[str]:
    board_id = config.board or board.board_id
    if board_id:
        return ["--board", quote(board_id)]

    context_paths = [
        Path.cwd() / ".fizzy.yaml",
        Path(config.workspace) / ".fizzy.yaml",
    ]
    if any(path.exists() for path in context_paths):
        return []

    raise ValueError(
        "Board context requires .fizzy.yaml or an explicit board ID via Board.board_id or FizzyConfig.board."
    )


def _agent_markdown_parts() -> List[str]:
    return ["--agent", "--markdown"]


def _agent_quiet_parts() -> List[str]:
    return ["--agent", "--quiet"]


def build_doctor_command(config: FizzyConfig) -> str:
    """Build the recommended health check command for setup/config/auth issues."""
    return " ".join([quote(config.fizzy_bin), "doctor"])


def build_card_list_command(board: Board, config: FizzyConfig) -> str:
    """Build the Fizzy CLI list command for board cards."""
    parts: List[str] = [quote(config.fizzy_bin), "card", "list"]
    parts.extend(_board_flag_parts(board, config))
    parts.extend(_agent_markdown_parts())
    parts.extend(config.extra_flags)
    return " ".join(parts)


def build_card_show_command(
    agent: Agent,
    card: CardAdapter,
    config: FizzyConfig,
) -> str:
    """Build the Fizzy CLI show command for a single card number."""
    parts: List[str] = [
        quote(config.fizzy_bin),
        "card",
        "show",
        str(card.number),
    ]
    parts.extend(_agent_markdown_parts())
    parts.extend(config.extra_flags)
    return " ".join(parts)


def build_card_column_command(card: CardAdapter, config: FizzyConfig) -> str:
    """Build the Fizzy CLI command to move a card to a column."""
    parts: List[str] = [
        quote(config.fizzy_bin),
        "card",
        "column",
        str(card.number),
        "--column",
        quote(card.column_id),
    ]
    parts.extend(_agent_quiet_parts())
    parts.extend(config.extra_flags)
    return " ".join(parts)


def build_comment_create_command(card: CardAdapter, config: FizzyConfig) -> str:
    """Build the Fizzy CLI command to create a comment on a card."""
    body = card.comment_body if card.comment_body else card.title
    parts: List[str] = [
        quote(config.fizzy_bin),
        "comment",
        "create",
        "--card",
        str(card.number),
        "--body",
        quote(body),
    ]
    parts.extend(_agent_quiet_parts())
    parts.extend(config.extra_flags)
    return " ".join(parts)


def build_card_command(
    agent: Agent,
    board: Board,
    card: CardAdapter,
    config: FizzyConfig,
) -> str:
    """Build the primary Fizzy CLI command for a card adapter."""
    _ = board
    return build_card_show_command(agent, card, config)


def build_board_plan(
    board: Board,
    config: FizzyConfig,
) -> List[Dict[str, str]]:
    """Build a dry-run execution plan for an entire tracker board."""
    plan: List[Dict[str, str]] = []
    list_command = build_card_list_command(board, config)
    doctor_command = build_doctor_command(config)
    board_context = config.board or board.board_id or ".fizzy.yaml"
    for card in board.cards:
        plan.append(
            {
                "board": board.name,
                "board_context": board_context,
                "tracker": board.tracker,
                "card_number": str(card.number),
                "title": card.title,
                "agent": card.agent.name,
                "column_id": card.column_id,
                "labels": ", ".join(card.labels),
                "doctor_command": doctor_command,
                "list_command": list_command,
                "show_command": build_card_show_command(card.agent, card, config),
                "column_command": build_card_column_command(card, config),
                "comment_command": build_comment_create_command(card, config),
            }
        )
    return plan


def format_plan_as_text(plan: List[Dict[str, str]]) -> str:
    """Render a board plan (from :func:`build_board_plan`) as human-readable text."""
    if not plan:
        return "(empty board — no cards defined)"

    lines: List[str] = ["=== Fizzy Symphony — Dry-Run Board Plan ===", ""]
    lines.append(f"Setup check  : {plan[0]['doctor_command']}")
    lines.append(f"Board ctx    : {plan[0]['board_context']}")
    lines.append("")
    for i, entry in enumerate(plan, start=1):
        lines.append(f"Card {i}: [#{entry['card_number']}]")
        lines.append(f"  Title          : {entry['title']}")
        lines.append(f"  Agent          : {entry['agent']}")
        lines.append(f"  Board          : {entry['board']}")
        lines.append(f"  Tracker        : {entry['tracker']}")
        lines.append(f"  Column ID      : {entry['column_id']}")
        if entry["labels"]:
            lines.append(f"  Labels         : {entry['labels']}")
        lines.append(f"  List command   : {entry['list_command']}")
        lines.append(f"  Show command   : {entry['show_command']}")
        lines.append(f"  Move command   : {entry['column_command']}")
        lines.append(f"  Comment command: {entry['comment_command']}")
        lines.append("")
    return "\n".join(lines)


build_agent_command = build_card_command
build_workflow_plan = build_board_plan
