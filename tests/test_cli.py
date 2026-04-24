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
    assert "work-ai-board" in captured.out
    assert "fizzy" in captured.out
    assert "fizzy doctor" in captured.out
    assert "fizzy card claim 42 --board work-ai-board" in captured.out
    assert "(dry-run mode — no commands were executed)" in captured.out


def test_list_command_prints_dry_run_fizzy_command(capsys):
    exit_code = main(["list", "--board", "work-ai-board", "--dry-run"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "fizzy card list --board work-ai-board --agent --markdown" in captured.out


def test_claim_command_prints_dry_run_fizzy_command(capsys):
    exit_code = main(["claim", "42", "--board", "work-ai-board", "--dry-run"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "fizzy card claim 42 --board work-ai-board --agent --quiet" in captured.out


def test_comment_command_prints_dry_run_fizzy_command(capsys):
    exit_code = main(["comment", "42", "--body", "hello world", "--dry-run"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "fizzy comment create --card 42 --body 'hello world' --agent --quiet" in captured.out


def test_move_command_prints_dry_run_fizzy_command(capsys):
    exit_code = main(["move", "42", "--column", "ready-to-ship", "--dry-run"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "fizzy card column 42 --column ready-to-ship --agent --quiet" in captured.out
