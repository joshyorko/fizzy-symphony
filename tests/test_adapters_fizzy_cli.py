from pathlib import Path

import pytest

from fizzy_symphony.adapters.fizzy_cli import FizzyCLIAdapter
from fizzy_symphony.models import FizzyConfig


def _make_adapter(**kwargs) -> FizzyCLIAdapter:
    defaults = dict(fizzy_bin="fizzy", workspace="/tmp/ws", dry_run=True)
    defaults.update(kwargs)
    return FizzyCLIAdapter(config=FizzyConfig(**defaults))


def test_build_list_command_uses_explicit_board():
    cmd = _make_adapter().build_list_command("work-ai-board")
    assert cmd == "fizzy card list --board work-ai-board --agent --markdown"


def test_build_claim_command_uses_card_number_and_board():
    cmd = _make_adapter().build_claim_command(42, "work-ai-board")
    assert cmd == "fizzy card claim 42 --board work-ai-board --agent --quiet"


def test_build_comment_command_quotes_body():
    cmd = _make_adapter().build_comment_command(42, "Progress update for the card.")
    assert cmd == "fizzy comment create --card 42 --body 'Progress update for the card.' --agent --quiet"


def test_build_move_command_uses_column_id():
    cmd = _make_adapter().build_move_command(42, "ready-to-ship")
    assert cmd == "fizzy card column 42 --column ready-to-ship --agent --quiet"


def test_build_list_command_can_fall_back_to_fizzy_yaml(tmp_path, monkeypatch):
    (tmp_path / ".fizzy.yaml").write_text("board: from-file\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    cmd = _make_adapter(workspace=str(tmp_path), board=None).build_list_command()
    assert cmd == "fizzy card list --agent --markdown"


def test_adapter_rejects_non_dry_run():
    with pytest.raises(ValueError, match="dry-run only"):
        _make_adapter(dry_run=False, board="work-ai-board").build_list_command()
