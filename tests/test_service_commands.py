import json
from pathlib import Path

from fizzy_symphony.cli import main


class _FakePopen:
    def __init__(self, command, **kwargs):
        self.command = command
        self.kwargs = kwargs
        self.pid = 42424


class _FakeCompleted:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr


def test_setup_writes_local_config_and_env_file(tmp_path, capsys):
    config_dir = tmp_path / ".fizzy-symphony"
    workspace = tmp_path / "rails-todo"

    exit_code = main(
        [
            "setup",
            "--config-dir",
            str(config_dir),
            "--workspace",
            str(workspace),
            "--prompt-file",
            "devdata/rails-todo.prompt.md",
            "--board-name",
            "Fizzy Symphony Rails Todo",
            "--card-title",
            "Build a simple Rails todo app",
            "--run-mode",
            "once",
        ]
    )
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "Config written" in captured.out
    assert "Env written" in captured.out

    config = json.loads((config_dir / "config.json").read_text(encoding="utf-8"))
    env = json.loads((config_dir / "env.json").read_text(encoding="utf-8"))

    assert config["robot_path"] == "robots/workitems/robot.yaml"
    assert config["rcc_bin"] == "rcc"
    assert config["output_dir"] == str(config_dir / "output")
    assert env["FIZZY_SYMPHONY_WORKSPACE"] == str(workspace)
    assert env["FIZZY_SYMPHONY_PROMPT_FILE"] == "devdata/rails-todo.prompt.md"
    assert env["FIZZY_SYMPHONY_BOARD_ID"] == ""
    assert env["FIZZY_SYMPHONY_CARD_NUMBER"] == ""


def test_start_launches_detached_by_default_and_writes_run_file(tmp_path, monkeypatch, capsys):
    config_dir = tmp_path / ".fizzy-symphony"
    main(
        [
            "setup",
            "--config-dir",
            str(config_dir),
            "--workspace",
            str(tmp_path / "rails-todo"),
            "--prompt-file",
            "devdata/rails-todo.prompt.md",
        ]
    )
    launched = {}

    def fake_popen(command, **kwargs):
        launched["command"] = command
        launched["kwargs"] = kwargs
        return _FakePopen(command, **kwargs)

    monkeypatch.setattr("fizzy_symphony.service_commands.subprocess.Popen", fake_popen)

    exit_code = main(["start", "--config-dir", str(config_dir)])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "Started Fizzy Symphony" in captured.out
    assert launched["command"] == [
        "rcc",
        "run",
        "-r",
        "robots/workitems/robot.yaml",
        "-t",
        "FizzySymphony",
        "-e",
        str(config_dir / "env.json"),
        "--silent",
    ]
    run_state = json.loads((config_dir / "run.json").read_text(encoding="utf-8"))
    assert run_state["pid"] == 42424
    assert run_state["command"] == launched["command"]
    assert Path(run_state["log_path"]).name == "service.log"


def test_start_detach_flag_remains_accepted(tmp_path, monkeypatch, capsys):
    config_dir = tmp_path / ".fizzy-symphony"
    main(
        [
            "setup",
            "--config-dir",
            str(config_dir),
            "--workspace",
            str(tmp_path / "rails-todo"),
            "--prompt-file",
            "devdata/rails-todo.prompt.md",
        ]
    )
    launched = {}

    def fake_popen(command, **kwargs):
        launched["command"] = command
        launched["kwargs"] = kwargs
        return _FakePopen(command, **kwargs)

    monkeypatch.setattr("fizzy_symphony.service_commands.subprocess.Popen", fake_popen)

    exit_code = main(["start", "--config-dir", str(config_dir), "--detach"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "Started Fizzy Symphony" in captured.out
    assert launched["command"][-1] == "--silent"


def test_start_foreground_runs_rcc_without_detaching(tmp_path, monkeypatch, capsys):
    config_dir = tmp_path / ".fizzy-symphony"
    main(
        [
            "setup",
            "--config-dir",
            str(config_dir),
            "--workspace",
            str(tmp_path / "rails-todo"),
            "--prompt-file",
            "devdata/rails-todo.prompt.md",
        ]
    )
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return _FakeCompleted(returncode=0)

    monkeypatch.setattr("fizzy_symphony.service_commands.subprocess.run", fake_run)

    exit_code = main(["start", "--config-dir", str(config_dir), "--foreground"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "foreground" in captured.out
    assert calls[0][0] == [
        "rcc",
        "run",
        "-r",
        "robots/workitems/robot.yaml",
        "-t",
        "FizzySymphony",
        "-e",
        str(config_dir / "env.json"),
        "--silent",
    ]


def test_status_reports_configured_board_and_latest_artifact(tmp_path, capsys):
    config_dir = tmp_path / ".fizzy-symphony"
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    (output_dir / "fizzy-symphony-status.json").write_text(
        json.dumps(
            {
                "status": "PASS",
                "phase": "complete",
                "board_id": "board-123",
                "card_number": 55,
                "sdk": {"thread_id": "thread-1", "run_id": "run-1"},
                "summary_path": str(output_dir / "fizzy-symphony-summary.json"),
            }
        ),
        encoding="utf-8",
    )
    config_dir.mkdir()
    (config_dir / "config.json").write_text(
        json.dumps(
            {
                "robot_path": "robots/workitems/robot.yaml",
                "rcc_bin": "rcc",
                "output_dir": str(output_dir),
            }
        ),
        encoding="utf-8",
    )
    (config_dir / "env.json").write_text("{}", encoding="utf-8")
    (config_dir / "run.json").write_text(
        json.dumps({"pid": 999999, "command": ["rcc"], "log_path": str(config_dir / "service.log")}),
        encoding="utf-8",
    )

    exit_code = main(["status", "--config-dir", str(config_dir)])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "Fizzy Symphony Status" in captured.out
    assert "process: stopped" in captured.out
    assert "phase: complete" in captured.out
    assert "board: board-123" in captured.out
    assert "card: 55" in captured.out
    assert "thread-1" in captured.out
    assert "run-1" in captured.out


def test_status_reports_running_worker_phase(tmp_path, capsys):
    config_dir = tmp_path / ".fizzy-symphony"
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    (output_dir / "fizzy-symphony-status.json").write_text(
        json.dumps(
            {
                "status": "RUNNING",
                "phase": "worker_running",
                "board_id": "board-456",
                "card_number": 77,
                "worker": {"input_id": "input-1", "state": "RESERVED"},
                "queue": {"input_queue": "fizzy_codex_input", "state": "RESERVED"},
                "sdk": {
                    "preflight_thread_id": "pre-thread",
                    "preflight_run_id": "pre-run",
                },
                "heartbeat_at": "2026-04-26T16:10:00Z",
            }
        ),
        encoding="utf-8",
    )
    config_dir.mkdir()
    (config_dir / "config.json").write_text(
        json.dumps({"output_dir": str(output_dir)}),
        encoding="utf-8",
    )
    (config_dir / "run.json").write_text(
        json.dumps({"pid": 999999, "command": ["rcc"], "log_path": str(config_dir / "service.log")}),
        encoding="utf-8",
    )

    exit_code = main(["status", "--config-dir", str(config_dir)])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert "status: RUNNING" in captured.out
    assert "phase: worker_running" in captured.out
    assert "card: 77" in captured.out
    assert "worker: RESERVED input=input-1" in captured.out
    assert "heartbeat: 2026-04-26T16:10:00Z" in captured.out


def test_boards_runs_fizzy_board_list(monkeypatch, capsys):
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return _FakeCompleted(stdout="Board: Example\n")

    monkeypatch.setattr("fizzy_symphony.service_commands.subprocess.run", fake_run)

    exit_code = main(["boards"])
    captured = capsys.readouterr()

    assert exit_code == 0
    assert calls[0][0] == ["fizzy", "board", "list", "--markdown"]
    assert "Board: Example" in captured.out
