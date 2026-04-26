"""
Tests for fizzy_symphony.commands — covers the CLI-backed command builders,
build_board_plan, and format_plan_as_text.
"""

import pytest

from fizzy_symphony.commands import (
    build_board_plan,
    build_card_claim_command,
    build_card_claim_commands,
    build_card_column_command,
    build_card_command,
    build_card_list_command,
    build_card_show_command,
    build_comment_create_command,
    build_doctor_command,
    format_plan_as_text,
)
from fizzy_symphony.models import Agent, Board, CardAdapter, FizzyConfig


def _make_agent(**kwargs) -> Agent:
    defaults = dict(name="test-agent", model="gpt-4o", max_tokens=4096, temperature=0.2)
    defaults.update(kwargs)
    return Agent(**defaults)


def _make_card(number=1, title="Do something", **kwargs) -> CardAdapter:
    agent = kwargs.pop("agent", _make_agent())
    return CardAdapter(number=number, title=title, agent=agent, **kwargs)


def _make_board(**kwargs) -> Board:
    defaults = dict(
        name="test-board",
        tracker="fizzy",
        board_id="work-ai-board",
        cards=[],
    )
    defaults.update(kwargs)
    return Board(**defaults)


def _make_config(**kwargs) -> FizzyConfig:
    defaults = dict(fizzy_bin="fizzy", workspace="/tmp/ws", dry_run=True, timeout_seconds=300)
    defaults.update(kwargs)
    return FizzyConfig(**defaults)


class TestCommandBuilders:
    def test_build_doctor_command(self):
        assert build_doctor_command(_make_config()) == "fizzy doctor"

    def test_build_card_list_command_uses_board_context_and_agent_markdown(self):
        cmd = build_card_list_command(_make_board(), _make_config())
        assert cmd == "fizzy card list --board work-ai-board --agent --markdown"

    def test_build_card_list_command_can_fall_back_to_fizzy_yaml(self, tmp_path, monkeypatch):
        (tmp_path / ".fizzy.yaml").write_text("board: 03fromfile\n", encoding="utf-8")
        monkeypatch.chdir(tmp_path)
        cfg = _make_config(workspace=str(tmp_path))
        cmd = build_card_list_command(_make_board(board_id=None), cfg)
        assert cmd == "fizzy card list --agent --markdown"

    def test_build_card_list_command_requires_board_context_when_missing(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        cfg = _make_config(workspace=str(tmp_path), board=None)
        with pytest.raises(ValueError, match="Board context"):
            build_card_list_command(_make_board(board_id=None), cfg)

    def test_build_card_claim_commands_use_card_number(self):
        commands = build_card_claim_commands(_make_board(), _make_card(number=42), _make_config())
        assert commands == [
            "fizzy card show 42 --agent --markdown",
            "fizzy card column 42 --column 'In Flight' --agent --quiet",
            "fizzy comment create --card 42 --body 'Do something' --agent --quiet",
        ]

    def test_build_card_claim_command_keeps_compatibility_string_output(self):
        cmd = build_card_claim_command(_make_board(), _make_card(number=42), _make_config())
        assert "fizzy card show 42 --agent --markdown" in cmd
        assert "fizzy card claim" not in cmd

    def test_build_card_show_command_uses_card_number(self):
        cmd = build_card_show_command(_make_agent(), _make_card(number=42), _make_config())
        assert cmd == "fizzy card show 42 --agent --markdown"

    def test_build_card_column_command_uses_column_id(self):
        cmd = build_card_column_command(_make_card(number=42, column_id="col_123"), _make_config())
        assert cmd == "fizzy card column 42 --column col_123 --agent --quiet"

    def test_build_comment_create_command_uses_comment_body(self):
        card = _make_card(number=42, comment_body="Moved this card through the CLI adapter.")
        cmd = build_comment_create_command(card, _make_config())
        assert (
            cmd
            == "fizzy comment create --card 42 --body 'Moved this card through the CLI adapter.' --agent --quiet"
        )

    def test_build_comment_create_command_falls_back_to_title(self):
        card = _make_card(number=42, title="Describe the function.", comment_body=None)
        cmd = build_comment_create_command(card, _make_config())
        assert "--body 'Describe the function.'" in cmd

    def test_build_card_command_aliases_show_command(self):
        card = _make_card(number=42)
        cmd = build_card_command(_make_agent(), _make_board(), card, _make_config())
        assert cmd == "fizzy card show 42 --agent --markdown"

    def test_extra_flags_appended(self):
        cfg = _make_config(extra_flags=["--verbose"])
        cmd = build_card_show_command(_make_agent(), _make_card(number=42), cfg)
        assert cmd.endswith("--verbose")


class TestBuildBoardPlan:
    def _make_board(self) -> Board:
        c1 = _make_card(number=42, title="First card")
        c2 = _make_card(
            number=57,
            title="Second card",
            column_id="col_ready",
            labels=["docs", "tests"],
        )
        return _make_board(cards=[c1, c2])

    def test_plan_length_matches_cards(self):
        board = self._make_board()
        plan = build_board_plan(board, _make_config())
        assert len(plan) == 2

    def test_plan_entry_keys(self):
        board = self._make_board()
        plan = build_board_plan(board, _make_config())
        for entry in plan:
            assert "board" in entry
            assert "board_context" in entry
            assert "tracker" in entry
            assert "card_number" in entry
            assert "title" in entry
            assert "agent" in entry
            assert "column_id" in entry
            assert "labels" in entry
            assert "doctor_command" in entry
            assert "list_command" in entry
            assert "claim_command" in entry
            assert "claim_commands" in entry
            assert "show_command" in entry
            assert "column_command" in entry
            assert "comment_command" in entry

    def test_card_numbers_in_order(self):
        board = self._make_board()
        plan = build_board_plan(board, _make_config())
        assert plan[0]["card_number"] == "42"
        assert plan[1]["card_number"] == "57"

    def test_board_name_in_plan_entry(self):
        board = self._make_board()
        plan = build_board_plan(board, _make_config())
        assert plan[0]["board"] == "test-board"
        assert plan[0]["board_context"] == "work-ai-board"

    def test_labels_empty_when_card_has_none(self):
        board = self._make_board()
        plan = build_board_plan(board, _make_config())
        assert plan[0]["labels"] == ""

    def test_labels_joined_with_comma(self):
        board = self._make_board()
        plan = build_board_plan(board, _make_config())
        assert plan[1]["labels"] == "docs, tests"

    def test_empty_board_returns_empty_plan(self):
        board = _make_board()
        plan = build_board_plan(board, _make_config())
        assert plan == []


class TestFormatPlanAsText:
    def _plan(self) -> list:
        board = _make_board(
            name="fmt-board",
            tracker="fizzy",
            board_id="03fmtboard",
            cards=[
                _make_card(number=101, title="Alpha card"),
                _make_card(number=102, title="Beta card", labels=["docs"]),
            ],
        )
        return build_board_plan(board, _make_config())

    def test_returns_string(self):
        text = format_plan_as_text(self._plan())
        assert isinstance(text, str)

    def test_contains_header(self):
        text = format_plan_as_text(self._plan())
        assert "Dry-Run Board Plan" in text

    def test_contains_card_numbers(self):
        text = format_plan_as_text(self._plan())
        assert "#101" in text
        assert "#102" in text

    def test_contains_tracker_and_board(self):
        text = format_plan_as_text(self._plan())
        assert "fmt-board" in text
        assert "fizzy" in text
        assert "03fmtboard" in text

    def test_empty_plan_returns_empty_message(self):
        text = format_plan_as_text([])
        assert "empty" in text.lower()

    def test_labels_shown_when_present(self):
        text = format_plan_as_text(self._plan())
        assert "docs" in text

    def test_commands_present_in_output(self):
        text = format_plan_as_text(self._plan())
        assert "fizzy doctor" in text
        assert "fizzy card list" in text
        assert "fizzy card show 101" in text
        assert "fizzy card column 101 --column 'In Flight'" in text
        assert "fizzy comment create --card 101" in text
