"""Dry-run Fizzy CLI adapter.

This adapter only builds the Fizzy CLI commands that would run. It never
executes subprocesses and deliberately rejects non-dry-run operation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from shlex import quote
from typing import List, Optional

from ..models import FizzyConfig


@dataclass(frozen=True)
class FizzyCLIAdapter:
    """Build dry-run Fizzy CLI commands for cards and boards."""

    config: FizzyConfig = field(default_factory=FizzyConfig)

    def build_doctor_command(self) -> str:
        """Build the recommended health check command."""
        return " ".join([quote(self.config.fizzy_bin), "doctor"])

    def build_column_list_command(self, board: Optional[str] = None) -> str:
        """Build the Fizzy CLI command used to list board columns."""
        parts: List[str] = [quote(self.config.fizzy_bin), "column", "list"]
        parts.extend(self._board_flag_parts(board))
        parts.extend(self._agent_quiet_parts())
        parts.extend(self.config.extra_flags)
        return " ".join(parts)

    def build_column_create_command(self, board: str, name: str) -> str:
        """Build the Fizzy CLI command used to create a board column."""
        self._ensure_dry_run()
        if not board:
            raise ValueError("board must not be empty.")
        if not name:
            raise ValueError("name must not be empty.")
        parts: List[str] = [
            quote(self.config.fizzy_bin),
            "column",
            "create",
            "--board",
            quote(board),
            "--name",
            quote(name),
        ]
        parts.extend(self._agent_quiet_parts())
        parts.extend(self.config.extra_flags)
        return " ".join(parts)

    def build_list_command(self, board: Optional[str] = None) -> str:
        """Build the Fizzy CLI command used to list board cards."""
        parts: List[str] = [quote(self.config.fizzy_bin), "card", "list"]
        parts.extend(self._board_flag_parts(board))
        parts.extend(self._agent_markdown_parts())
        parts.extend(self.config.extra_flags)
        return " ".join(parts)

    def build_claim_command(self, card_number: int, board: Optional[str] = None) -> str:
        """Build the Fizzy CLI command used to claim a card by number."""
        self._validate_card_number(card_number)
        parts: List[str] = [quote(self.config.fizzy_bin), "card", "claim", str(card_number)]
        parts.extend(self._board_flag_parts(board))
        parts.extend(self._agent_quiet_parts())
        parts.extend(self.config.extra_flags)
        return " ".join(parts)

    def build_show_command(self, card_number: int) -> str:
        """Build the Fizzy CLI command used to show a card by number."""
        self._validate_card_number(card_number)
        parts: List[str] = [quote(self.config.fizzy_bin), "card", "show", str(card_number)]
        parts.extend(self._agent_markdown_parts())
        parts.extend(self.config.extra_flags)
        return " ".join(parts)

    def build_move_command(self, card_number: int, column_id: str) -> str:
        """Build the Fizzy CLI command used to move a card to a column."""
        self._validate_card_number(card_number)
        if not column_id:
            raise ValueError("column_id must not be empty.")
        parts: List[str] = [
            quote(self.config.fizzy_bin),
            "card",
            "column",
            str(card_number),
            "--column",
            quote(column_id),
        ]
        parts.extend(self._agent_quiet_parts())
        parts.extend(self.config.extra_flags)
        return " ".join(parts)

    def build_comment_command(self, card_number: int, body: str) -> str:
        """Build the Fizzy CLI command used to comment on a card."""
        self._validate_card_number(card_number)
        if not body:
            raise ValueError("body must not be empty.")
        parts: List[str] = [
            quote(self.config.fizzy_bin),
            "comment",
            "create",
            "--card",
            str(card_number),
            "--body",
            quote(body),
        ]
        parts.extend(self._agent_quiet_parts())
        parts.extend(self.config.extra_flags)
        return " ".join(parts)

    def _board_flag_parts(self, board: Optional[str]) -> List[str]:
        self._ensure_dry_run()
        resolved_board = board or self.config.board
        if resolved_board:
            return ["--board", quote(resolved_board)]

        context_paths = [Path.cwd() / ".fizzy.yaml", Path(self.config.workspace) / ".fizzy.yaml"]
        if any(path.exists() for path in context_paths):
            return []

        raise ValueError(
            "Board context requires .fizzy.yaml or an explicit board ID via the adapter input or FizzyConfig.board."
        )

    def _ensure_dry_run(self) -> None:
        if not self.config.dry_run:
            raise ValueError("FizzyCLIAdapter is dry-run only in this scaffold.")

    @staticmethod
    def _agent_markdown_parts() -> List[str]:
        return ["--agent", "--markdown"]

    @staticmethod
    def _agent_quiet_parts() -> List[str]:
        return ["--agent", "--quiet"]

    @staticmethod
    def _validate_card_number(card_number: int) -> None:
        if card_number < 1:
            raise ValueError("card_number must be >= 1.")
