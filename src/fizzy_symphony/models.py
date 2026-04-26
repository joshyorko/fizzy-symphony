"""
Data models for Fizzy Symphony.

These dataclasses describe the revised scaffold:
  - FizzyCard   : normalized canonical card shape used across adapters.
  - Agent       : a Codex coding agent with an identity and optional capabilities.
  - CardAdapter : a compatibility wrapper used by the dry-run planning scaffold.
  - Board       : an ordered collection of card adapters for a tracker board.
  - FizzyConfig : runtime configuration used when building Fizzy commands.

Compatibility aliases for `Task`, `Workflow`, and `TaskStatus` remain available
in Phase 0 to ease migration from the previous scaffold and are intended to be
removed in a future major revision.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, List, Mapping, Optional, Sequence


class CardStatus(str, Enum):
    """Lifecycle states for a card on a tracker board."""

    BACKLOG = "backlog"
    READY = "ready"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    BLOCKED = "blocked"


class AgentCapability(str, Enum):
    """Broad capability categories an Agent may advertise."""

    CODE_GENERATION = "code_generation"
    CODE_REVIEW = "code_review"
    TESTING = "testing"
    DOCUMENTATION = "documentation"
    REFACTORING = "refactoring"


BACKEND_TAGS = ("codex", "claude", "opencode", "anthropic", "openai")
AGENT_INSTRUCTIONS_TAG = "agent-instructions"
DEFAULT_AGENT_BACKEND = "codex"
DEFAULT_COMPLETION_POLICY = "comment"


@dataclass(frozen=True)
class GoldenTicket:
    """Board-native routing contract parsed from a Fizzy instruction card.

    A golden ticket is a Fizzy card tagged ``#agent-instructions`` that lives in
    the column it configures. Fizzy remains the source of truth for the card;
    this model only captures the routing policy the orchestrator needs.
    """

    card_id: str
    card_number: int
    column_id: str
    column_name: str
    prompt: str = ""
    steps: List[str] = field(default_factory=list)
    backend: str = DEFAULT_AGENT_BACKEND
    completion_policy: str = DEFAULT_COMPLETION_POLICY

    def __post_init__(self) -> None:
        if not self.card_id:
            raise ValueError("GoldenTicket.card_id must not be empty.")
        if self.card_number < 1:
            raise ValueError("GoldenTicket.card_number must be >= 1.")
        if not self.column_id:
            raise ValueError("GoldenTicket.column_id must not be empty.")
        if not self.column_name:
            raise ValueError("GoldenTicket.column_name must not be empty.")
        if not self.backend:
            raise ValueError("GoldenTicket.backend must not be empty.")
        if not self.completion_policy:
            raise ValueError("GoldenTicket.completion_policy must not be empty.")


def parse_golden_ticket_card(
    card: Mapping[str, Any],
    *,
    default_backend: str = DEFAULT_AGENT_BACKEND,
) -> Optional[GoldenTicket]:
    """Parse a Fizzy card-shaped mapping into a :class:`GoldenTicket`.

    This is a deliberately small spec stub. It accepts the card shape returned
    by the CLI/API enough to define semantics, but it does not perform network
    calls or mutate Fizzy.
    """
    tags = [_normalize_tag(tag) for tag in card.get("tags", [])]
    if AGENT_INSTRUCTIONS_TAG not in tags:
        return None

    column = card.get("column")
    if not isinstance(column, Mapping):
        return None

    column_id = str(column.get("id") or "")
    column_name = str(column.get("name") or "")
    if not column_id or not column_name:
        return None

    return GoldenTicket(
        card_id=str(card.get("id") or ""),
        card_number=int(card.get("number") or 0),
        column_id=column_id,
        column_name=column_name,
        prompt=str(card.get("description") or ""),
        steps=_parse_step_contents(card.get("steps", [])),
        backend=_resolve_backend(tags, default_backend=default_backend),
        completion_policy=_resolve_completion_policy(tags),
    )


def _normalize_tag(tag: object) -> str:
    return str(tag).strip().lower().lstrip("#")


def _resolve_backend(tags: Sequence[str], *, default_backend: str) -> str:
    for tag in tags:
        if tag in BACKEND_TAGS:
            return tag
    return default_backend


def _resolve_completion_policy(tags: Sequence[str]) -> str:
    for tag in tags:
        if tag == "close-on-complete":
            return "close"
        if tag.startswith("move-to-"):
            column_name = tag.removeprefix("move-to-").replace("-", " ")
            return f"move:{column_name}"
    return DEFAULT_COMPLETION_POLICY


def _parse_step_contents(raw_steps: object) -> List[str]:
    if not isinstance(raw_steps, list):
        return []

    steps: List[str] = []
    for step in raw_steps:
        if isinstance(step, Mapping):
            content = str(step.get("content") or "").strip()
        else:
            content = str(step).strip()
        if content:
            steps.append(content)
    return steps


@dataclass
class FizzyCard:
    """Normalized Fizzy card shape.

    The canonical tracker model uses both the internal card ``id`` and the
    human-facing ``number`` because Fizzy CLI commands operate on ``number``.
    """

    id: str
    number: int
    identifier: str
    title: str
    description: str = ""
    state: str = ""
    url: Optional[str] = None
    labels: List[str] = field(default_factory=list)
    priority: Optional[str] = None
    blocked_by: List[str] = field(default_factory=list)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    branch_name: Optional[str] = None
    column_id: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.id:
            raise ValueError("FizzyCard.id must not be empty.")
        if self.number < 1:
            raise ValueError("FizzyCard.number must be >= 1.")
        if not self.identifier:
            raise ValueError("FizzyCard.identifier must not be empty.")
        if not self.title:
            raise ValueError("FizzyCard.title must not be empty.")
        if not self.state:
            raise ValueError("FizzyCard.state must not be empty.")


@dataclass
class Agent:
    """Represents a Codex coding agent.

    Attributes:
        name: Human-readable identifier for the agent.
        model: The underlying Codex/LLM model tag (e.g. ``"gpt-4o"``).
        capabilities: Optional list of :class:`AgentCapability` values.
        max_tokens: Upper bound on tokens the agent may produce per turn.
        temperature: Sampling temperature in ``[0.0, 2.0]``.
    """

    name: str
    model: str = "gpt-4o"
    capabilities: List[AgentCapability] = field(default_factory=list)
    max_tokens: int = 4096
    temperature: float = 0.2

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("Agent.name must not be empty.")
        if not (0.0 <= self.temperature <= 2.0):
            raise ValueError(
                f"Agent.temperature must be in [0.0, 2.0]; got {self.temperature}."
            )
        if self.max_tokens < 1:
            raise ValueError(
                f"Agent.max_tokens must be >= 1; got {self.max_tokens}."
            )


@dataclass
class CardAdapter:
    """A tracker card adapted into the dry-run planning model.

    Attributes:
        number: The Fizzy card number used by the CLI.
        title: Human-readable title for the card.
        agent: The :class:`Agent` responsible for handling the card.
        column_id: The target board column ID for move commands.
        labels: Optional card labels or tags from the tracker.
        status: Current lifecycle status of the card.
        comment_body: Optional comment body for CLI-backed note creation.
    """

    number: int
    title: str
    agent: Agent
    column_id: str = "backlog"
    labels: List[str] = field(default_factory=list)
    status: CardStatus = CardStatus.BACKLOG
    comment_body: Optional[str] = None

    def __post_init__(self) -> None:
        if self.number < 1:
            raise ValueError("CardAdapter.number must be >= 1.")
        if not self.title:
            raise ValueError("CardAdapter.title must not be empty.")
        if not self.column_id:
            raise ValueError("CardAdapter.column_id must not be empty.")

    def as_fizzy_card(
        self,
        *,
        card_id: str,
        identifier: str,
        state: str,
        description: str = "",
        url: Optional[str] = None,
        priority: Optional[str] = None,
        blocked_by: Optional[List[str]] = None,
        created_at: Optional[str] = None,
        updated_at: Optional[str] = None,
        branch_name: Optional[str] = None,
    ) -> FizzyCard:
        """Convert the compatibility adapter into the canonical card shape."""
        return FizzyCard(
            id=card_id,
            number=self.number,
            identifier=identifier,
            title=self.title,
            description=description,
            state=state,
            url=url,
            labels=list(self.labels),
            priority=priority,
            blocked_by=list(blocked_by or []),
            created_at=created_at,
            updated_at=updated_at,
            branch_name=branch_name,
            column_id=self.column_id,
        )


@dataclass
class Board:
    """An ordered collection of tracker cards forming a dry-run board plan.

    Attributes:
        name: Human-readable name for the board.
        tracker: The upstream tracker or board provider name.
        board_id: Optional Fizzy board identifier for `--board`.
        cards: Ordered list of :class:`CardAdapter` objects.
        description: Optional longer description of the board's purpose.
    """

    name: str
    tracker: str = "fizzy"
    board_id: Optional[str] = None
    cards: List[CardAdapter] = field(default_factory=list)
    description: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("Board.name must not be empty.")
        if not self.tracker:
            raise ValueError("Board.tracker must not be empty.")

    def add_card(self, card: CardAdapter) -> None:
        """Append a card adapter to the board."""
        self.cards.append(card)

    def card_numbers(self) -> List[int]:
        """Return an ordered list of card numbers in this board."""
        return [card.number for card in self.cards]

    def get_card(self, number: int) -> Optional[CardAdapter]:
        """Look up a card adapter by number; returns ``None`` if not found."""
        for card in self.cards:
            if card.number == number:
                return card
        return None


@dataclass
class FizzyConfig:
    """Runtime configuration used when constructing Fizzy commands.

    Attributes:
        fizzy_bin: Path or name of the ``fizzy`` executable.
        workspace: Working directory for Fizzy job execution.
        board: Optional explicit Fizzy board ID override.
        dry_run: When ``True``, commands are printed but never executed.
        extra_flags: Additional flags forwarded verbatim to Fizzy.
        timeout_seconds: Per-card execution timeout in seconds.
    """

    fizzy_bin: str = "fizzy"
    workspace: str = "/tmp/fizzy-workspace"
    board: Optional[str] = None
    dry_run: bool = True
    extra_flags: List[str] = field(default_factory=list)
    timeout_seconds: int = 300

    def __post_init__(self) -> None:
        if not self.fizzy_bin:
            raise ValueError("FizzyConfig.fizzy_bin must not be empty.")
        if self.timeout_seconds < 1:
            raise ValueError(
                f"FizzyConfig.timeout_seconds must be >= 1; got {self.timeout_seconds}."
            )


# Phase 0 compatibility aliases for the previous scaffold vocabulary.
TaskStatus = CardStatus
Task = CardAdapter
Workflow = Board
