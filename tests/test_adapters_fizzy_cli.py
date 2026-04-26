from pathlib import Path

import pytest

from fizzy_symphony.adapters.fizzy_cli import FizzyCLIAdapter
from fizzy_symphony.adapters.fizzy_openapi import FizzyOpenAPIAdapter
from fizzy_symphony.models import FizzyConfig
from fizzy_symphony.symphony import FizzyCustomColumn


def _make_adapter(**kwargs) -> FizzyCLIAdapter:
    defaults = dict(fizzy_bin="fizzy", workspace="/tmp/ws", dry_run=True)
    defaults.update(kwargs)
    return FizzyCLIAdapter(config=FizzyConfig(**defaults))


def test_build_list_command_uses_explicit_board():
    cmd = _make_adapter().build_list_command("work-ai-board")
    assert cmd == "fizzy card list --board work-ai-board --agent --markdown"


def test_build_column_commands_use_existing_board():
    adapter = _make_adapter()

    assert (
        adapter.build_column_list_command("board-1")
        == "fizzy column list --board board-1 --agent --quiet"
    )
    assert (
        adapter.build_column_create_command("board-1", "Ready for Agents")
        == "fizzy column create --board board-1 --name 'Ready for Agents' --agent --quiet"
    )


def test_build_claim_commands_returns_composite_sequence_without_assignment():
    commands = _make_adapter().build_claim_commands(42, "in-flight", "Claimed by fizzy-symphony worker.")
    assert commands == [
        "fizzy card show 42 --agent --markdown",
        "fizzy card column 42 --column in-flight --agent --quiet",
        "fizzy comment create --card 42 --body 'Claimed by fizzy-symphony worker.' --agent --quiet",
    ]


def test_build_claim_commands_can_include_self_assign():
    commands = _make_adapter().build_claim_commands(42, "in-flight", "Claimed by worker.", self_assign=True)
    assert commands == [
        "fizzy card show 42 --agent --markdown",
        "fizzy card self-assign 42 --agent --quiet",
        "fizzy card column 42 --column in-flight --agent --quiet",
        "fizzy comment create --card 42 --body 'Claimed by worker.' --agent --quiet",
    ]


def test_build_claim_commands_can_include_explicit_assignee():
    commands = _make_adapter().build_claim_commands(
        42,
        "in-flight",
        "Claimed by worker.",
        assignee_id="user-123",
    )
    assert commands == [
        "fizzy card show 42 --agent --markdown",
        "fizzy card assign 42 --user user-123 --agent --quiet",
        "fizzy card column 42 --column in-flight --agent --quiet",
        "fizzy comment create --card 42 --body 'Claimed by worker.' --agent --quiet",
    ]


def test_claim_card_never_emits_fake_single_claim_command():
    commands = _make_adapter().claim_card(42, "in-flight", "Claimed by worker.")
    assert "fizzy card claim" not in "\n".join(commands)


def test_build_comment_command_quotes_body():
    cmd = _make_adapter().build_comment_command(42, "Progress update for the card.")
    assert cmd == "fizzy comment create --card 42 --body 'Progress update for the card.' --agent --quiet"


def test_build_move_command_uses_column_id():
    cmd = _make_adapter().build_move_command(42, "ready-to-ship")
    assert cmd == "fizzy card column 42 --column ready-to-ship --agent --quiet"


def test_build_move_command_maps_system_lanes():
    adapter = _make_adapter()

    assert adapter.build_move_command(42, "maybe") == "fizzy card untriage 42 --agent --quiet"
    assert adapter.build_move_command(42, "not-now") == "fizzy card postpone 42 --agent --quiet"
    assert adapter.build_move_command(42, "done") == "fizzy card close 42 --agent --quiet"


def test_build_move_command_resolves_unique_custom_column_name():
    cmd = _make_adapter().build_move_command(
        42,
        "Ready",
        custom_columns=[
            FizzyCustomColumn(column_id="col_ready", name="Ready"),
            FizzyCustomColumn(column_id="col_review", name="Review"),
        ],
    )

    assert cmd == "fizzy card column 42 --column col_ready --agent --quiet"


def test_build_move_command_rejects_ambiguous_custom_column_name():
    with pytest.raises(ValueError, match="Duplicate custom column name 'Ready'.*column IDs"):
        _make_adapter().build_move_command(
            42,
            "Ready",
            custom_columns=[
                FizzyCustomColumn(column_id="col_a", name="Ready"),
                FizzyCustomColumn(column_id="col_b", name="Ready"),
            ],
        )


def test_build_list_command_can_fall_back_to_fizzy_yaml(tmp_path, monkeypatch):
    (tmp_path / ".fizzy.yaml").write_text("board: from-file\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    cmd = _make_adapter(workspace=str(tmp_path), board=None).build_list_command()
    assert cmd == "fizzy card list --agent --markdown"


def test_adapter_rejects_non_dry_run():
    with pytest.raises(ValueError, match="dry-run only"):
        _make_adapter(dry_run=False, board="work-ai-board").build_list_command()


def test_build_claim_commands_reject_non_dry_run():
    with pytest.raises(ValueError, match="dry-run only"):
        _make_adapter(dry_run=False).build_claim_commands(42, "in-flight", "Claimed by worker.")


def test_claim_card_does_not_execute_subprocesses(monkeypatch):
    import subprocess

    def _fail(*args, **kwargs):  # noqa: ARG001
        raise AssertionError("subprocess execution is not allowed")

    monkeypatch.setattr(subprocess, "run", _fail)
    commands = _make_adapter().claim_card(42, "in-flight", "Claimed by worker.")
    assert commands[0] == "fizzy card show 42 --agent --markdown"


def test_openapi_adapter_is_explicit_future_stub_and_does_not_execute_http(monkeypatch):
    import urllib.request

    def _fail(*args, **kwargs):  # noqa: ARG001
        raise AssertionError("HTTP execution is not allowed")

    monkeypatch.setattr(urllib.request, "urlopen", _fail)
    adapter = FizzyOpenAPIAdapter()
    assert adapter.sdk_repository == "https://github.com/basecamp/fizzy-sdk"
    assert "Future real API-backed tracker adapter" in adapter.__doc__
