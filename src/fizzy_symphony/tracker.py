"""Tracker adapter contract for normalized Fizzy cards."""

from __future__ import annotations

from typing import Dict, Protocol, Sequence

from .models import FizzyCard


class TrackerAdapter(Protocol):
    """Protocol for tracker integrations used by the dispatcher scaffold."""

    def fetch_candidate_cards(self) -> Sequence[FizzyCard]:
        """Return cards eligible to be claimed by workers."""

    def fetch_cards_by_states(self, states: Sequence[str]) -> Sequence[FizzyCard]:
        """Return cards whose current state is in ``states``."""

    def fetch_card_states_by_ids(self, card_ids: Sequence[str]) -> Dict[str, str]:
        """Return the latest state name keyed by internal card ID."""

    def create_comment(self, card_id: str, body: str) -> None:
        """Create a tracker comment or update for a card."""

    def update_card_state(self, card_id: str, state_name: str) -> None:
        """Move a card into a new tracker state."""
