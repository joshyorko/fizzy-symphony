"""
Data models for Fizzy Symphony.

These dataclasses describe the revised scaffold:
  - Agent       : a Codex coding agent with an identity and optional capabilities.
  - CardAdapter : a tracker card mapped into the Fizzy CLI contract.
  - Board       : an ordered collection of card adapters for a tracker board.
  - FizzyConfig : runtime configuration used when building Fizzy commands.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional


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
    """A tracker card adapted into the Fizzy CLI planning model.

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


TaskStatus = CardStatus
Task = CardAdapter
Workflow = Board
