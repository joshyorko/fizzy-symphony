import json

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
    assert "fizzy card show 42 --agent --markdown" in captured.out
    assert "fizzy card column 42 --column 'In Flight' --agent --quiet" in captured.out
    assert "(dry-run mode — no commands were executed)" in captured.out


def test_doctor_command_prints_symphony_mapping(capsys):
    exit_code = main(["doctor", "--board", "board-1"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "Fizzy Symphony Doctor" in captured.out
    assert "fizzy doctor" in captured.out
    assert "Linear issue -> Fizzy card" in captured.out
    assert "robocorp-adapters-custom" in captured.out


def test_init_board_prints_existing_board_bootstrap_plan(capsys):
    exit_code = main(["init-board", "--board", "board-1"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "configure an existing tracker board" in captured.out
    assert "fizzy column list --board board-1 --agent --quiet" in captured.out
    assert "fizzy column create --board board-1 --name 'Ready for Agents'" in captured.out


def test_workitems_env_prints_adapter_environment(capsys):
    exit_code = main(["workitems-env"])
    captured = capsys.readouterr()

    assert exit_code == 0
    data = json.loads(captured.out)
    assert data["RC_WORKITEM_ADAPTER"] == "robocorp_adapters_custom._sqlite.SQLiteAdapter"
    assert data["RC_WORKITEM_QUEUE_NAME"] == "fizzy_codex_input"


def test_list_command_prints_dry_run_fizzy_command(capsys):
    exit_code = main(["list", "--board", "work-ai-board", "--dry-run"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "fizzy card list --board work-ai-board --agent --markdown" in captured.out


def test_claim_command_prints_composite_dry_run_fizzy_commands(capsys):
    exit_code = main(["claim", "42", "--board", "work-ai-board", "--dry-run"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "fizzy card show 42 --agent --markdown" in captured.out
    assert "fizzy card column 42 --column 'In Flight' --agent --quiet" in captured.out
    assert "fizzy comment create --card 42 --body 'Claimed by fizzy-symphony worker.'" in captured.out
    assert "fizzy card claim" not in captured.out


def test_claim_command_supports_self_assign(capsys):
    exit_code = main(["claim", "42", "--self-assign", "--dry-run"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "fizzy card self-assign 42 --agent --quiet" in captured.out


def test_claim_command_supports_explicit_assignee_and_custom_values(capsys):
    exit_code = main(
        [
            "claim",
            "42",
            "--in-flight-column",
            "col_123",
            "--comment-body",
            "Claimed by custom worker.",
            "--assignee-id",
            "user-123",
            "--dry-run",
        ]
    )
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "fizzy card assign 42 --user user-123 --agent --quiet" in captured.out
    assert "fizzy card column 42 --column col_123 --agent --quiet" in captured.out
    assert "fizzy comment create --card 42 --body 'Claimed by custom worker.'" in captured.out


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
