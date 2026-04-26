"""Tracker adapter contract for normalized Fizzy cards."""

from __future__ import annotations

from typing import Dict, List, Optional, Protocol, Sequence

from .models import FizzyCard


class TrackerAdapter(Protocol):
    """Protocol for tracker integrations used by the dispatcher scaffold."""

    def get_card(self, card_number: int) -> FizzyCard:
        """Return a single card by visible card number."""

    def fetch_candidate_cards(self) -> Sequence[FizzyCard]:
        """Return cards eligible to be claimed by workers."""

    def fetch_cards_by_states(self, states: Sequence[str]) -> Sequence[FizzyCard]:
        """Return cards whose current state is in ``states``."""

    def fetch_card_states_by_ids(self, card_ids: Sequence[str]) -> Dict[str, str]:
        """Return the latest state name keyed by internal card ID."""

    def create_comment(self, card_number: int, body: str) -> None:
        """Create a tracker comment or update for a card."""

    def move_card_to_column(self, card_number: int, column_id: str) -> None:
        """Move a card into a new tracker column."""

    def assign_card(self, card_number: int, user_id: str) -> None:
        """Assign a card to a specific user."""

    def self_assign_card(self, card_number: int) -> None:
        """Assign the current user to the card."""

    def claim_card(
        self,
        card_number: int,
        in_flight_column_id: str,
        comment_body: str,
        assignee_id: Optional[str] = None,
        self_assign: bool = False,
    ) -> List[str]:
        """Perform the orchestration-level composite claim operation."""
