"""OpenAI Symphony alignment primitives.

This module keeps the public mental model close to upstream Symphony while
letting Fizzy Symphony use Fizzy and Robocorp workitems underneath.
"""

from __future__ import annotations

from dataclasses import dataclass
from shlex import quote
from typing import List, Optional, Tuple


@dataclass(frozen=True)
class SymphonyColumn:
    """Recommended Fizzy column for a Symphony-style board."""

    name: str
    role: str
    upstream_state: Optional[str]
    description: str


@dataclass(frozen=True)
class SymphonyMapping:
    """Concept mapping between upstream Symphony and this implementation."""

    upstream: str
    fizzy_symphony: str
    note: str


RECOMMENDED_COLUMNS: Tuple[SymphonyColumn, ...] = (
    SymphonyColumn(
        name="Shaping",
        role="Backlog/refinement",
        upstream_state="Backlog",
        description="Human-scoped work that is not ready for an agent yet.",
    ),
    SymphonyColumn(
        name="Ready for Agents",
        role="Agent intake",
        upstream_state="Todo",
        description="Cards eligible for producer enqueueing.",
    ),
    SymphonyColumn(
        name="In Flight",
        role="Claimed/running",
        upstream_state="In Progress",
        description="Cards currently owned by an automated worker.",
    ),
    SymphonyColumn(
        name="Needs Input",
        role="Blocked handoff",
        upstream_state="Blocked",
        description="Worker needs human clarification before continuing.",
    ),
    SymphonyColumn(
        name="Synthesize & Verify",
        role="Human review",
        upstream_state="Human Review",
        description="Completed worker output awaiting review or integration.",
    ),
    SymphonyColumn(
        name="Ready to Ship",
        role="Integration",
        upstream_state="Ready",
        description="Verified work that can be merged or released.",
    ),
    SymphonyColumn(
        name="Done",
        role="Terminal",
        upstream_state="Done",
        description="No more automated work should occur.",
    ),
)


UPSTREAM_MAPPING: Tuple[SymphonyMapping, ...] = (
    SymphonyMapping(
        upstream="Linear project",
        fizzy_symphony="Fizzy board",
        note="Existing tracker workspace; not created automatically by default.",
    ),
    SymphonyMapping(
        upstream="Linear issue",
        fizzy_symphony="Fizzy card",
        note="The visible card remains the human source of truth.",
    ),
    SymphonyMapping(
        upstream="Orchestrator state",
        fizzy_symphony="Robocorp workitem state",
        note="Reserve/release/fail/output chaining lives in the adapter backend.",
    ),
    SymphonyMapping(
        upstream="Codex app-server session",
        fizzy_symphony="Codex worker command",
        note="Workers consume one queued card payload at a time.",
    ),
    SymphonyMapping(
        upstream="Issue comment/status update",
        fizzy_symphony="Fizzy comment/column update",
        note="Reporter publishes proof back to the original card.",
    ),
    SymphonyMapping(
        upstream="WORKFLOW.md",
        fizzy_symphony="WORKFLOW.md / WORKFLOW.example.md",
        note="Repository-owned workflow contract should drive worker behavior.",
    ),
)


def recommended_columns() -> List[SymphonyColumn]:
    """Return a copy of the recommended board columns."""
    return list(RECOMMENDED_COLUMNS)


def upstream_mapping() -> List[SymphonyMapping]:
    """Return a copy of the upstream-to-Fizzy mapping."""
    return list(UPSTREAM_MAPPING)


def format_init_board_plan(board_id: str, *, fizzy_bin: str = "fizzy") -> str:
    """Render dry-run commands for preparing an existing Fizzy board."""
    if not board_id:
        raise ValueError("board_id is required")

    lines = [
        "Fizzy Symphony board bootstrap plan",
        "",
        "This follows upstream Symphony: configure an existing tracker board; do not",
        "create a hidden system board by default.",
        "",
        f"Board: {board_id}",
        "",
        "Check existing columns first:",
        f"{quote(fizzy_bin)} column list --board {quote(board_id)} --agent --quiet",
        "",
        "Create any missing columns:",
    ]
    for column in RECOMMENDED_COLUMNS:
        lines.append(
            f"{quote(fizzy_bin)} column create --board {quote(board_id)} "
            f"--name {quote(column.name)} --agent --quiet"
        )
    return "\n".join(lines)


def format_mapping_table() -> str:
    """Render a compact text table explaining how this follows Symphony."""
    lines = ["OpenAI Symphony mapping", ""]
    for mapping in UPSTREAM_MAPPING:
        lines.append(f"- {mapping.upstream} -> {mapping.fizzy_symphony}: {mapping.note}")
    return "\n".join(lines)
