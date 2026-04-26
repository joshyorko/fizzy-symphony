"""OpenAI Symphony alignment primitives.

This module keeps the public mental model close to upstream Symphony while
letting Fizzy Symphony use Fizzy and Robocorp workitems underneath.
"""

from __future__ import annotations

from dataclasses import dataclass
from shlex import quote
from typing import Any, List, Mapping, Optional, Sequence, Tuple, Union


@dataclass(frozen=True)
class SymphonyColumn:
    """Recommended Fizzy column for a Symphony-style board."""

    name: str
    role: str
    upstream_state: Optional[str]
    description: str


@dataclass(frozen=True)
class FizzySystemLane:
    """Built-in Fizzy lane that is not created as a custom board column."""

    name: str
    pseudo_id: str
    kind: str
    role: str
    description: str


@dataclass(frozen=True)
class FizzyCustomColumn:
    """Known custom Fizzy board column used for name-to-ID resolution."""

    column_id: str
    name: str

    def __post_init__(self) -> None:
        if not self.column_id:
            raise ValueError("FizzyCustomColumn.column_id must not be empty.")
        if not self.name:
            raise ValueError("FizzyCustomColumn.name must not be empty.")


@dataclass(frozen=True)
class FizzyLaneTarget:
    """Resolved target lane for a card move/update plan."""

    kind: str
    display_name: str
    column_id: Optional[str] = None
    pseudo_id: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.kind:
            raise ValueError("FizzyLaneTarget.kind must not be empty.")
        if self.kind == "custom_column" and not self.column_id:
            raise ValueError("FizzyLaneTarget.column_id is required for custom columns.")
        if self.kind != "custom_column" and not self.pseudo_id:
            raise ValueError("FizzyLaneTarget.pseudo_id is required for system lanes.")


@dataclass(frozen=True)
class SymphonyMapping:
    """Concept mapping between upstream Symphony and this implementation."""

    upstream: str
    fizzy_symphony: str
    note: str


FIZZY_SYSTEM_LANES: Tuple[FizzySystemLane, ...] = (
    FizzySystemLane(
        name="Maybe?",
        pseudo_id="maybe",
        kind="triage",
        role="Default intake",
        description="Active cards with no custom column assignment.",
    ),
    FizzySystemLane(
        name="Not Now",
        pseudo_id="not-now",
        kind="not_now",
        role="Postponed",
        description="Cards postponed out of active automation.",
    ),
    FizzySystemLane(
        name="Done",
        pseudo_id="done",
        kind="closed",
        role="Terminal",
        description="Closed cards; no more automated work should occur.",
    ),
)

FIZZY_SYSTEM_LANE_ALIASES = {
    "maybe": "maybe",
    "triage": "maybe",
    "not-now": "not-now",
    "not now": "not-now",
    "not_now": "not-now",
    "done": "done",
    "closed": "done",
}


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


def fizzy_system_lanes() -> List[FizzySystemLane]:
    """Return Fizzy's built-in pseudo lanes used by the orchestration model."""
    return list(FIZZY_SYSTEM_LANES)


def resolve_fizzy_lane(
    target: str,
    *,
    custom_columns: Sequence[Union[FizzyCustomColumn, Mapping[str, Any]]] = (),
) -> FizzyLaneTarget:
    """Resolve a requested card lane into a custom column or immutable system lane.

    Unknown non-system targets are treated as already-known Fizzy column IDs so
    existing boards can keep their own workflow names and IDs.
    """
    requested = target.strip() if target else ""
    if not requested:
        raise ValueError("target lane must not be empty.")

    system_lane = _system_lane_for_target(requested)
    if system_lane is not None:
        return FizzyLaneTarget(
            kind=system_lane.kind,
            display_name=system_lane.name,
            pseudo_id=system_lane.pseudo_id,
        )

    columns = [_coerce_custom_column(column) for column in custom_columns]
    for column in columns:
        if requested == column.column_id:
            return FizzyLaneTarget(
                kind="custom_column",
                display_name=column.name,
                column_id=column.column_id,
            )

    requested_name = _normalize_column_name(requested)
    name_matches = [
        column
        for column in columns
        if _normalize_column_name(column.name) == requested_name
    ]
    if len(name_matches) > 1:
        raise ValueError(
            f"Duplicate custom column name {requested!r}; use column IDs to disambiguate."
        )
    if name_matches:
        column = name_matches[0]
        return FizzyLaneTarget(
            kind="custom_column",
            display_name=column.name,
            column_id=column.column_id,
        )

    return FizzyLaneTarget(kind="custom_column", display_name=requested, column_id=requested)


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
        "Fizzy system lanes already exist and are not custom columns:",
    ]
    for lane in FIZZY_SYSTEM_LANES:
        lines.append(f"- {lane.name} ({lane.pseudo_id}, {lane.kind})")
    lines.extend(
        [
            "",
            "Check existing custom columns first:",
            f"{quote(fizzy_bin)} column list --board {quote(board_id)} --agent --quiet",
            "",
            "Create any missing custom workflow columns:",
        ]
    )
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


def _system_lane_for_target(target: str) -> Optional[FizzySystemLane]:
    pseudo_id = FIZZY_SYSTEM_LANE_ALIASES.get(_normalize_lane_token(target))
    if pseudo_id is None:
        return None
    for lane in FIZZY_SYSTEM_LANES:
        if lane.pseudo_id == pseudo_id:
            return lane
    return None


def _coerce_custom_column(column: Union[FizzyCustomColumn, Mapping[str, Any]]) -> FizzyCustomColumn:
    if isinstance(column, FizzyCustomColumn):
        return column
    column_id = str(column.get("column_id") or column.get("id") or "")
    name = str(column.get("name") or column.get("column_name") or "")
    return FizzyCustomColumn(column_id=column_id, name=name)


def _normalize_lane_token(value: str) -> str:
    token = _normalize_column_name(value).replace("_", "-")
    if token.endswith("?"):
        token = token[:-1]
    return token


def _normalize_column_name(value: str) -> str:
    return " ".join(value.strip().lower().split())
