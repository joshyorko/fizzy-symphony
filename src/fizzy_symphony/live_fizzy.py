"""Live Fizzy CLI client.

Unlike the dry-run adapter, this module executes the Fizzy CLI and parses the
JSON output expected from agent-friendly commands.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from typing import Any, List, Mapping, Optional, Union


class FizzyLiveClientError(RuntimeError):
    """Raised when the live Fizzy CLI command fails or returns invalid output."""


DEFAULT_FIZZY_TIMEOUT_SECONDS = 30.0
FIZZY_TIMEOUT_ENV = "FIZZY_SYMPHONY_FIZZY_TIMEOUT_SECONDS"
CardNumber = Union[int, str]


def parse_fizzy_timeout_seconds(raw: Optional[str], *, default: float = DEFAULT_FIZZY_TIMEOUT_SECONDS) -> float:
    """Return a positive Fizzy CLI timeout in seconds."""

    if raw is None or raw == "":
        return default
    try:
        timeout = float(raw)
    except ValueError as error:
        raise ValueError(f"{FIZZY_TIMEOUT_ENV} must be a positive number of seconds.") from error
    if timeout <= 0:
        raise ValueError(f"{FIZZY_TIMEOUT_ENV} must be a positive number of seconds.")
    return timeout


def fizzy_timeout_seconds_from_environment(env: Optional[Mapping[str, str]] = None) -> float:
    values = os.environ if env is None else env
    return parse_fizzy_timeout_seconds(values.get(FIZZY_TIMEOUT_ENV))


@dataclass(frozen=True)
class FizzyLiveClient:
    """Execute live Fizzy CLI commands and parse JSON responses when expected."""

    fizzy_bin: str = "fizzy"
    timeout_seconds: float = DEFAULT_FIZZY_TIMEOUT_SECONDS

    def doctor(self) -> Any:
        return self._run_json(["doctor"])

    def board_show(self, board: str) -> Any:
        self._ensure_value("board", board)
        return self._run_json(["board", "show", board])

    def board_list(self) -> Any:
        return self._run_json(["board", "list", "--all"])

    def column_list(self, board: str) -> Any:
        self._ensure_value("board", board)
        return self._run_json(["column", "list", "--board", board])

    def card_list(self, board: str) -> Any:
        self._ensure_value("board", board)
        return self._run_json(["card", "list", "--board", board, "--all"])

    def card_show(self, card_number: CardNumber) -> Any:
        return self._run_json(["card", "show", self._card_number(card_number)])

    def comment_list(self, card_number: CardNumber) -> Any:
        return self._run_json(["comment", "list", "--card", self._card_number(card_number)])

    def board_create(self, name: str) -> Any:
        self._ensure_value("name", name)
        return self._run_json(["board", "create", "--name", name])

    def column_create(self, board: str, name: str) -> Any:
        self._ensure_value("board", board)
        self._ensure_value("name", name)
        return self._run_json(["column", "create", "--board", board, "--name", name])

    def card_create(self, board: str, title: str, description: Optional[str] = None) -> Any:
        self._ensure_value("board", board)
        self._ensure_value("title", title)
        command = ["card", "create", "--board", board, "--title", title]
        if description:
            command.extend(["--description", description])
        return self._run_json(command)

    def card_golden(self, card_number: CardNumber) -> None:
        self._run_no_json(["card", "golden", self._card_number(card_number)])

    def card_tag(self, card_number: CardNumber, tag: str) -> None:
        self._ensure_value("tag", tag)
        self._run_no_json(["card", "tag", self._card_number(card_number), "--tag", tag])

    def comment_create(self, card_number: CardNumber, body: str) -> None:
        self._ensure_value("body", body)
        self._run_no_json(["comment", "create", "--card", self._card_number(card_number), "--body", body])

    def card_column(self, card_number: CardNumber, column: str) -> None:
        self._ensure_value("column", column)
        self._run_no_json(["card", "column", self._card_number(card_number), "--column", column])

    def card_close(self, card_number: CardNumber) -> None:
        self._run_no_json(["card", "close", self._card_number(card_number)])

    def card_postpone(self, card_number: CardNumber) -> None:
        self._run_no_json(["card", "postpone", self._card_number(card_number)])

    def card_untriage(self, card_number: CardNumber) -> None:
        self._run_no_json(["card", "untriage", self._card_number(card_number)])

    def _run_json(self, args: List[str]) -> Any:
        completed = self._run(args + self._agent_quiet_args())
        output = completed.stdout.strip()
        try:
            return json.loads(output)
        except json.JSONDecodeError as error:
            raise FizzyLiveClientError(
                f"Invalid JSON from {self._display_command(completed.args)}: {error.msg}"
            ) from error

    def _run_no_json(self, args: List[str]) -> None:
        self._run(args + self._agent_quiet_args())

    def _run(self, args: List[str]) -> subprocess.CompletedProcess:
        command = [self.fizzy_bin] + args
        try:
            completed = subprocess.run(
                command,
                text=True,
                capture_output=True,
                check=False,
                timeout=self.timeout_seconds,
            )
        except subprocess.TimeoutExpired as error:
            raise FizzyLiveClientError(
                f"{self._display_command(command)} timed out after "
                f"{self._format_timeout(self.timeout_seconds)} seconds."
            ) from error
        except OSError as error:
            raise FizzyLiveClientError(
                f"Unable to run Fizzy CLI command {self._display_command(command)}. "
                f"Check that '{self.fizzy_bin}' is installed, executable, and available on PATH: {error}"
            ) from error
        if completed.returncode != 0:
            stderr = completed.stderr.strip()
            stdout = completed.stdout.strip()
            detail = stderr or stdout or "no output"
            raise FizzyLiveClientError(
                f"{self._display_command(command)} failed with exit code {completed.returncode}: {detail}"
            )
        return completed

    @staticmethod
    def _agent_quiet_args() -> List[str]:
        return ["--agent", "--quiet"]

    @staticmethod
    def _display_command(command: List[str]) -> str:
        return " ".join(command)

    @staticmethod
    def _format_timeout(timeout_seconds: float) -> str:
        return f"{timeout_seconds:g}"

    @staticmethod
    def _ensure_value(name: str, value: str) -> None:
        if not value:
            raise ValueError(f"{name} must not be empty.")

    @staticmethod
    def _card_number(card_number: CardNumber) -> str:
        if isinstance(card_number, bool):
            raise ValueError("card_number must be a visible card number, not a card id.")
        if isinstance(card_number, int):
            if card_number < 1:
                raise ValueError("card_number must be a visible card number >= 1.")
            return str(card_number)
        if (
            isinstance(card_number, str)
            and card_number.isascii()
            and card_number.isdecimal()
            and not card_number.startswith("0")
            and int(card_number) >= 1
        ):
            return card_number
        raise ValueError("card_number must be a visible card number, not a card id.")
