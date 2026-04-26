"""Compatibility command builders for Fizzy Symphony.

The canonical dry-run command construction now lives in
:mod:`fizzy_symphony.adapters.fizzy_cli`. This module keeps the original helper
functions available while delegating to the adapter.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from .adapters.fizzy_cli import FizzyCLIAdapter
from .models import Agent, Board, CardAdapter, FizzyConfig


def _adapter(config: FizzyConfig) -> FizzyCLIAdapter:
    return FizzyCLIAdapter(config=config)


def build_doctor_command(config: FizzyConfig) -> str:
    """Build the recommended health check command for setup/config/auth issues."""
    return _adapter(config).build_doctor_command()


def build_card_list_command(board: Board, config: FizzyConfig) -> str:
    """Build the Fizzy CLI list command for board cards."""
    return _adapter(config).build_list_command(board.board_id)


def build_card_claim_commands(
    board: Board,
    card: CardAdapter,
    config: FizzyConfig,
    *,
    in_flight_column_id: str = "In Flight",
    comment_body: Optional[str] = None,
    assignee_id: Optional[str] = None,
    self_assign: bool = False,
) -> List[str]:
    """Build the composite dry-run claim commands for a single card number."""
    _ = board
    return _adapter(config).build_claim_commands(
        card.number,
        in_flight_column_id,
        comment_body or card.comment_body or card.title,
        assignee_id=assignee_id,
        self_assign=self_assign,
    )


def build_card_claim_command(board: Board, card: CardAdapter, config: FizzyConfig) -> str:
    """Build a compatibility string for the composite claim preview."""
    return "\n".join(build_card_claim_commands(board, card, config))


def build_card_show_command(
    agent: Agent,
    card: CardAdapter,
    config: FizzyConfig,
) -> str:
    """Build the Fizzy CLI show command for a single card number."""
    _ = agent
    return _adapter(config).build_show_command(card.number)


def build_card_column_command(card: CardAdapter, config: FizzyConfig) -> str:
    """Build the Fizzy CLI command to move a card to a column."""
    return _adapter(config).build_move_command(card.number, card.column_id)


def build_comment_create_command(card: CardAdapter, config: FizzyConfig) -> str:
    """Build the Fizzy CLI command to create a comment on a card."""
    body = card.comment_body if card.comment_body else card.title
    return _adapter(config).build_comment_command(card.number, body)


def build_card_command(
    agent: Agent,
    board: Board,
    card: CardAdapter,
    config: FizzyConfig,
) -> str:
    """Build the primary Fizzy CLI command for a card adapter.

    The ``board`` parameter is retained for compatibility with the previous
    public helper signature and may be removed in a future major revision.
    """
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
        claim_commands = build_card_claim_commands(board, card, config)
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
                "claim_command": "\n".join(claim_commands),
                "claim_commands": claim_commands,
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
        lines.append("  Claim commands :")
        for command in entry["claim_commands"]:
            lines.append(f"    - {command}")
        lines.append(f"  Show command   : {entry['show_command']}")
        lines.append(f"  Move command   : {entry['column_command']}")
        lines.append(f"  Comment command: {entry['comment_command']}")
        lines.append("")
    return "\n".join(lines)


# Phase 0 compatibility aliases for the previous command-builder names.
build_agent_command = build_card_command
build_workflow_plan = build_board_plan
