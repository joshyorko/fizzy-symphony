from fizzy_symphony.cli import main


def test_version_command_prints_version(capsys):
    exit_code = main(["version"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "fizzy-symphony 0.1.0" in captured.out


def test_plan_command_prints_board_plan(capsys):
    exit_code = main(["plan"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "Dry-Run Board Plan" in captured.out
    assert "fizzy-scaffold" in captured.out
    assert "agent-skills/fizzy" in captured.out
    assert "fizzy doctor" in captured.out
    assert "fizzy card show 42" in captured.out
    assert "(dry-run mode — no commands were executed)" in captured.out
