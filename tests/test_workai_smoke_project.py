import importlib.util
import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SMOKE_DIR = ROOT / "test-projects" / "workai-smoke"
FIXTURE_PATH = SMOKE_DIR / "board.fixture.json"
BOOTSTRAP_PATH = SMOKE_DIR / "bootstrap_board.py"


def _load_bootstrap_module():
    spec = importlib.util.spec_from_file_location("workai_smoke_bootstrap", BOOTSTRAP_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_fixture_describes_disposable_board_and_cards():
    data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    assert data["board"]["name"] == "WorkAI Disposable Smoke"
    assert data["board"]["recommended_columns"] == [
        "Shaping",
        "Ready for Agents",
        "In Flight",
        "Needs Input",
        "Synthesize & Verify",
        "Ready to Ship",
    ]
    assert data["golden_tickets"][0]["title"].startswith("Golden:")
    assert data["golden_tickets"][0]["golden"] is True
    assert data["golden_tickets"][0]["tags"] == [
        "agent-instructions",
        "codex",
        "move-to-synthesize-and-verify",
    ]
    assert [card["number"] for card in data["task_cards"]] == [1, 2, 3]


def test_bootstrap_generates_dry_run_commands_with_fizzy_boundaries():
    bootstrap = _load_bootstrap_module()
    fixture = bootstrap.load_fixture(FIXTURE_PATH)

    commands = bootstrap.build_dry_run_commands(fixture, board_id="board_123")

    assert commands[0] == "fizzy doctor"
    assert "fizzy board create --name 'WorkAI Disposable Smoke' --agent --quiet" in commands
    assert "export WORKAI_SMOKE_BOARD_ID='<board id from fizzy board create>'" in commands
    assert (
        "fizzy column list --board ${WORKAI_SMOKE_BOARD_ID} --agent --quiet"
        in bootstrap.build_dry_run_commands(fixture)
    )
    assert "fizzy column list --board board_123 --agent --quiet" in commands
    assert (
        "fizzy column create --board board_123 --name 'Ready for Agents' --agent --quiet"
        in commands
    )
    assert not any("--name Done" in command for command in commands)
    assert "fizzy card tag '<GOLDEN_1_NUMBER>' --tag agent-instructions" in commands
    assert "fizzy card golden '<GOLDEN_1_NUMBER>'" in commands
    assert (
        "fizzy card column '<TASK_1_NUMBER>' --column '<Ready for Agents column id>'"
        in commands
    )
    assert any(command.startswith("fizzy card create --board board_123") for command in commands)
    assert not any("card show" in command or "card column 1" in command for command in commands)


def test_bootstrap_dry_run_does_not_execute_fizzy(monkeypatch, capsys):
    bootstrap = _load_bootstrap_module()

    def fail_run(*args, **kwargs):
        raise AssertionError("dry-run should not execute subprocess.run")

    monkeypatch.setattr(subprocess, "run", fail_run)

    exit_code = bootstrap.main(["--fixture", str(FIXTURE_PATH)])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "Dry run only" in captured.out
    assert "fizzy board create" in captured.out


def test_live_requires_explicit_board_id_before_execution(monkeypatch):
    bootstrap = _load_bootstrap_module()
    calls = []

    def record_run(command, check):
        calls.append((command, check))

    monkeypatch.setattr(subprocess, "run", record_run)

    try:
        bootstrap.main(["--fixture", str(FIXTURE_PATH), "--live"])
    except SystemExit as error:
        assert error.code == 2
    else:
        raise AssertionError("--live without --board-id or --create-board should exit")

    assert calls == []


def test_live_with_board_id_executes_configure_commands(monkeypatch, capsys):
    bootstrap = _load_bootstrap_module()
    calls = []

    def record_run(command, check, capture_output=False, text=False):
        calls.append((command, check))
        if capture_output:
            if command[:3] == ["fizzy", "column", "create"]:
                name = command[command.index("--name") + 1]
                return subprocess.CompletedProcess(command, 0, json.dumps({"id": f"col-{name}"}), "")
            if command[:3] == ["fizzy", "card", "create"]:
                return subprocess.CompletedProcess(command, 0, json.dumps({"number": 987}), "")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(subprocess, "run", record_run)

    exit_code = bootstrap.main(["--fixture", str(FIXTURE_PATH), "--live", "--board-id", "board_123"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert calls
    assert '"board_id": "board_123"' in captured.out
    assert all(call[1] is True for call in calls)
    assert ["fizzy", "column", "list", "--board", "board_123", "--agent", "--quiet"] in [
        call[0] for call in calls
    ]
    assert ["fizzy", "card", "tag", "987", "--tag", "agent-instructions"] in [
        call[0] for call in calls
    ]
    assert ["fizzy", "card", "golden", "987"] in [call[0] for call in calls]
    assert not any(call[0][:3] == ["fizzy", "board", "create"] for call in calls)


def test_live_can_create_disposable_board(monkeypatch, capsys):
    bootstrap = _load_bootstrap_module()
    calls = []

    def record_run(command, check, capture_output=False, text=False):
        calls.append((command, check))
        if capture_output:
            if command[:3] == ["fizzy", "board", "create"]:
                return subprocess.CompletedProcess(command, 0, json.dumps({"id": "board_live"}), "")
            if command[:3] == ["fizzy", "column", "create"]:
                name = command[command.index("--name") + 1]
                return subprocess.CompletedProcess(command, 0, json.dumps({"id": f"col-{name}"}), "")
            if command[:3] == ["fizzy", "card", "create"]:
                return subprocess.CompletedProcess(command, 0, json.dumps({"number": 654}), "")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(subprocess, "run", record_run)

    exit_code = bootstrap.main(["--fixture", str(FIXTURE_PATH), "--live", "--create-board"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert '"board_id": "board_live"' in captured.out
    assert any(call[0][:3] == ["fizzy", "board", "create"] for call in calls)
    assert ["fizzy", "column", "list", "--board", "board_live", "--agent", "--quiet"] in [
        call[0] for call in calls
    ]
