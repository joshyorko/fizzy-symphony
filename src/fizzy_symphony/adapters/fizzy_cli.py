"""Dry-run Fizzy CLI adapter.

This adapter only builds the Fizzy CLI commands that would run. It never
executes subprocesses and deliberately rejects non-dry-run operation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from shlex import quote
from typing import Any, List, Mapping, Optional, Sequence, Union

from ..models import FizzyConfig
from ..symphony import FizzyCustomColumn, FizzyLaneTarget, resolve_fizzy_lane


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

    def build_get_card_command(self, card_number: int) -> str:
        """Build the Fizzy CLI command used to show a card by number."""
        self._validate_card_number(card_number)
        parts: List[str] = [quote(self.config.fizzy_bin), "card", "show", str(card_number)]
        parts.extend(self._agent_markdown_parts())
        parts.extend(self.config.extra_flags)
        return " ".join(parts)

    def build_show_command(self, card_number: int) -> str:
        """Build the Fizzy CLI command used to show a card by number.

        Compatibility wrapper over :meth:`build_get_card_command`.
        """
        return self.build_get_card_command(card_number)

    def build_move_to_column_command(self, card_number: int, column_id: str) -> str:
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

    def build_move_command(
        self,
        card_number: int,
        target: str,
        *,
        custom_columns: Sequence[Union[FizzyCustomColumn, Mapping[str, Any]]] = (),
    ) -> str:
        """Build the Fizzy CLI command used to move a card to a lane.

        Custom lanes resolve to ``fizzy card column`` with a real column ID.
        Fizzy system lanes resolve to their dedicated card operation.
        """
        return self.build_move_to_lane_command(
            card_number,
            resolve_fizzy_lane(target, custom_columns=custom_columns),
        )

    def build_move_to_lane_command(self, card_number: int, lane: FizzyLaneTarget) -> str:
        """Build the Fizzy CLI command used to move a card to a resolved lane."""
        if lane.kind == "custom_column":
            return self.build_move_to_column_command(card_number, lane.column_id or "")
        if lane.kind == "triage":
            return self.build_untriage_card_command(card_number)
        if lane.kind == "not_now":
            return self.build_postpone_card_command(card_number)
        if lane.kind == "closed":
            return self.build_close_card_command(card_number)
        raise ValueError(f"Unsupported Fizzy lane kind: {lane.kind}")

    def build_untriage_card_command(self, card_number: int) -> str:
        """Build the Fizzy CLI command used to return a card to Maybe?/triage."""
        return self._build_card_system_lane_command("untriage", card_number)

    def build_postpone_card_command(self, card_number: int) -> str:
        """Build the Fizzy CLI command used to move a card to Not Now."""
        return self._build_card_system_lane_command("postpone", card_number)

    def build_close_card_command(self, card_number: int) -> str:
        """Build the Fizzy CLI command used to move a card to Done."""
        return self._build_card_system_lane_command("close", card_number)

    def build_create_comment_command(self, card_number: int, body: str) -> str:
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

    def build_comment_command(self, card_number: int, body: str) -> str:
        """Build the Fizzy CLI command used to comment on a card.

        Compatibility wrapper over :meth:`build_create_comment_command`.
        """
        return self.build_create_comment_command(card_number, body)

    def build_assign_card_command(self, card_number: int, user_id: str) -> str:
        """Build the Fizzy CLI command used to assign a card to a user."""
        self._validate_card_number(card_number)
        if not user_id:
            raise ValueError("user_id must not be empty.")
        parts: List[str] = [
            quote(self.config.fizzy_bin),
            "card",
            "assign",
            str(card_number),
            "--user",
            quote(user_id),
        ]
        parts.extend(self._agent_quiet_parts())
        parts.extend(self.config.extra_flags)
        return " ".join(parts)

    def build_self_assign_card_command(self, card_number: int) -> str:
        """Build the Fizzy CLI command used to self-assign a card."""
        self._validate_card_number(card_number)
        parts: List[str] = [quote(self.config.fizzy_bin), "card", "self-assign", str(card_number)]
        parts.extend(self._agent_quiet_parts())
        parts.extend(self.config.extra_flags)
        return " ".join(parts)

    def build_claim_commands(
        self,
        card_number: int,
        in_flight_column_id: str,
        comment_body: str,
        assignee_id: Optional[str] = None,
        self_assign: bool = False,
    ) -> List[str]:
        """Build the dry-run command sequence used to claim a card."""
        self._ensure_dry_run()
        if assignee_id and self_assign:
            raise ValueError("assignee_id and self_assign are mutually exclusive.")

        commands = [self.build_get_card_command(card_number)]
        if self_assign:
            commands.append(self.build_self_assign_card_command(card_number))
        elif assignee_id:
            commands.append(self.build_assign_card_command(card_number, assignee_id))
        commands.append(self.build_move_to_column_command(card_number, in_flight_column_id))
        commands.append(self.build_create_comment_command(card_number, comment_body))
        return commands

    def claim_card(
        self,
        card_number: int,
        in_flight_column_id: str,
        comment_body: str,
        assignee_id: Optional[str] = None,
        self_assign: bool = False,
    ) -> List[str]:
        """Return the composite dry-run command sequence for claiming a card."""
        return self.build_claim_commands(
            card_number,
            in_flight_column_id,
            comment_body,
            assignee_id=assignee_id,
            self_assign=self_assign,
        )

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

    def _build_card_system_lane_command(self, operation: str, card_number: int) -> str:
        self._ensure_dry_run()
        self._validate_card_number(card_number)
        parts: List[str] = [quote(self.config.fizzy_bin), "card", operation, str(card_number)]
        parts.extend(self._agent_quiet_parts())
        parts.extend(self.config.extra_flags)
        return " ".join(parts)

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
