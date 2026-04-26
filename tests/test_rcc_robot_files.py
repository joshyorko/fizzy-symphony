import json
import shutil
import subprocess
from pathlib import Path

import pytest

from fizzy_symphony.runners import CodexCliRunner, CodexRunResult
from robots.workitems import tasks as task_module
from robots.workitems.tasks import (
    FullSmokeBlocked,
    InMemoryWorkItemAdapter,
    run_fizzy_symphony_from_environment,
    run_prompt_card_smoke,
    run_smoke_sqlite_workitem_flow,
    run_workai_production_smoke,
)


ROOT = Path(__file__).resolve().parents[1]
ROBOT_ROOT = ROOT / "robots" / "workitems"
WORKAI_SAMPLE = ROOT / "test-projects" / "workai-smoke" / "sample_project"


def test_rcc_workitem_robot_files_exist():
    assert (ROBOT_ROOT / "robot.yaml").is_file()
    assert (ROBOT_ROOT / "conda.yaml").is_file()
    assert (ROBOT_ROOT / "requirements.txt").is_file()
    assert (ROBOT_ROOT / "tasks.py").is_file()
    assert (ROBOT_ROOT / "run_fizzy_symphony.py").is_file()
    assert (ROBOT_ROOT / "devdata" / "env-sqlite.json").is_file()
    assert (ROBOT_ROOT / "devdata" / "env-prompt-card.example.json").is_file()
    assert (ROBOT_ROOT / "devdata" / "prompt-card.prompt.md").is_file()
    assert (ROOT / "robot_tests" / "resources.robot").is_file()
    assert (ROOT / "robot_tests" / "fizzy_symphony.robot").is_file()


def test_robot_yaml_exposes_expected_tasks():
    robot_yaml = (ROBOT_ROOT / "robot.yaml").read_text(encoding="utf-8")

    assert "tasks:" in robot_yaml
    assert "FizzySymphony:" in robot_yaml
    assert "devTasks:" in robot_yaml
    assert "Doctor:" in robot_yaml
    assert "WorkitemsEnv:" in robot_yaml
    assert "SmokeSQLiteWorkitemFlow:" in robot_yaml
    assert "WorkAIProductionSmoke:" in robot_yaml
    assert "FizzySymphonyContractTest:" in robot_yaml
    assert "PromptCardSmoke:" in robot_yaml
    assert "RunSymphony:" in robot_yaml
    assert "robocorp.tasks" in robot_yaml


def test_rcc_conda_uses_focused_robocorp_packages():
    conda_yaml = (ROBOT_ROOT / "conda.yaml").read_text(encoding="utf-8")
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")

    assert "robocorp-tasks==" in conda_yaml
    assert "robocorp-log==" in conda_yaml
    assert "robocorp-workitems==" in conda_yaml
    assert "robocorp==" not in conda_yaml
    assert "robocorp-tasks>=" in pyproject
    assert "robocorp-log>=" in pyproject
    assert "robocorp-workitems>=" in pyproject
    assert '"robocorp==' not in pyproject
    assert "codex-app-server-sdk @ git+" in (ROBOT_ROOT / "requirements.txt").read_text(
        encoding="utf-8"
    )


def test_smoke_helper_runs_with_in_memory_adapter(tmp_path):
    adapter = InMemoryWorkItemAdapter()

    proof = run_smoke_sqlite_workitem_flow(
        adapter=adapter,
        output_dir=tmp_path,
        prefer_real_adapter=False,
    )

    assert proof["status"] == "PASS"
    assert proof["adapter"] == "provided"
    assert proof["safe_by_default"] is True
    assert proof["mutated_fizzy"] is False
    assert proof["output_payload"]["card_id"] == "smoke-card-1"
    assert proof["output_payload"]["comment"] == "Smoke runner completed card 1 without mutation."
    assert (tmp_path / "smoke-workitem-flow.json").is_file()


def test_workai_production_smoke_refuses_unavailable_or_cli_runner(tmp_path):
    sample_project = tmp_path / "sample_project"
    shutil.copytree(WORKAI_SAMPLE, sample_project)

    with pytest.raises(FullSmokeBlocked, match="Codex SDK runner"):
        run_workai_production_smoke(
            board_id="board_disposable",
            output_dir=tmp_path / "output",
            sample_project_dir=sample_project,
            runner=_UnavailableSdkRunner(),
            prefer_real_adapter=False,
        )
    with pytest.raises(FullSmokeBlocked, match="not CodexCliRunner"):
        run_workai_production_smoke(
            board_id="board_disposable",
            output_dir=tmp_path / "output-cli",
            sample_project_dir=sample_project,
            runner=CodexCliRunner(command=["python", "-c", "print('not sdk')"]),
            prefer_real_adapter=False,
        )


def test_workai_production_smoke_runs_all_cards_with_sdk_runner(tmp_path):
    sample_project = tmp_path / "sample_project"
    shutil.copytree(WORKAI_SAMPLE, sample_project)
    runner = _ScriptedSdkRunner()

    summary = run_workai_production_smoke(
        board_id="board_disposable",
        output_dir=tmp_path / "output",
        sample_project_dir=sample_project,
        runner=runner,
        prefer_real_adapter=False,
        live_fizzy=False,
    )

    assert summary["status"] == "PASS"
    assert summary["board"]["id"] == "board_disposable"
    assert summary["board"]["mutated_fizzy"] is False
    assert summary["board"]["cleanup_command"] == "fizzy board delete board_disposable"
    assert summary["preflight"]["sdk"]["thread_id"] == "thread-preflight"
    assert summary["preflight"]["sqlite_workitems"]["adapter"] == "in-memory"
    assert [item["card_number"] for item in summary["cards"]] == list(range(1, 9))
    assert all(item["sdk"]["thread_id"].startswith("thread-card-") for item in summary["cards"])
    assert all(item["sdk"]["run_id"].startswith("run-card-") for item in summary["cards"])
    assert all(item["report_back"]["mode"] == "dry-run" for item in summary["cards"])
    assert any("fizzy card golden" in command for command in summary["board"]["setup_commands"])
    first_report_commands = summary["cards"][0]["report_back"]["commands"]
    assert any("fizzy comment create --card 1" in command for command in first_report_commands)
    assert any("<Synthesize & Verify column id>" in command for command in first_report_commands)
    assert summary["sample_project_tests"]["returncode"] == 0
    assert "passed" in summary["sample_project_tests"]["stdout"]
    assert runner.card_numbers == [1, 2, 3, 4, 5, 6, 7, 8]
    cli_text = (sample_project / "workai_smoke" / "cli.py").read_text(encoding="utf-8")
    readme_text = (sample_project / "README.md").read_text(encoding="utf-8")
    test_text = (sample_project / "tests" / "test_cli.py").read_text(encoding="utf-8")
    assert cli_text.count("--json") == 1
    assert "Smoke completion checklist" in readme_text
    assert "test_json_output_mode" in test_text
    assert Path(summary["artifacts"]["summary_path"]).is_file()
    assert Path(summary["artifacts"]["pytest_output_path"]).is_file()


def test_workai_production_smoke_live_mode_requires_real_card_mapping(tmp_path):
    sample_project = tmp_path / "sample_project"
    shutil.copytree(WORKAI_SAMPLE, sample_project)

    with pytest.raises(FullSmokeBlocked, match="GOLDEN_CARD_NUMBER"):
        run_workai_production_smoke(
            board_id="board_disposable",
            output_dir=tmp_path / "output",
            sample_project_dir=sample_project,
            runner=_ScriptedSdkRunner(),
            prefer_real_adapter=False,
            live_fizzy=True,
            handoff_column_id="col_synthesize_and_verify",
        )


def test_prompt_card_smoke_runs_one_prompt_with_sdk_runner(tmp_path):
    sample_project = tmp_path / "sample_project"
    shutil.copytree(WORKAI_SAMPLE, sample_project)
    runner = _ScriptedPromptSdkRunner()

    summary = run_prompt_card_smoke(
        board_id="board_prompt",
        card_number=42,
        prompt="Create prompt-proof.txt",
        workspace=sample_project,
        output_dir=tmp_path / "output",
        runner=runner,
        prefer_real_adapter=False,
        live_fizzy=False,
    )

    assert summary["status"] == "PASS"
    assert summary["board"]["mutated_fizzy"] is False
    assert summary["card_number"] == 42
    assert summary["preflight"]["sqlite_workitems"]["adapter"] == "in-memory"
    assert summary["sdk"]["thread_id"] == "thread-card-42"
    assert summary["report_back"]["mode"] == "dry-run"
    assert (sample_project / "prompt-proof.txt").read_text(encoding="utf-8") == "ok"
    assert Path(summary["artifacts"]["summary_path"]).is_file()


def test_prompt_card_smoke_can_load_prompt_from_env_file_path(tmp_path, monkeypatch):
    sample_project = tmp_path / "sample_project"
    shutil.copytree(WORKAI_SAMPLE, sample_project)
    prompt_path = tmp_path / "prompt.md"
    prompt_path.write_text("Create prompt-proof.txt from a prompt file", encoding="utf-8")
    monkeypatch.setenv("FIZZY_SYMPHONY_PROMPT_FILE", str(prompt_path))

    summary = run_prompt_card_smoke(
        board_id="board_prompt",
        card_number=42,
        prompt=None,
        workspace=sample_project,
        output_dir=tmp_path / "output",
        runner=_ScriptedPromptSdkRunner(),
        prefer_real_adapter=False,
        live_fizzy=False,
    )

    assert summary["status"] == "PASS"
    assert (sample_project / "prompt-proof.txt").read_text(encoding="utf-8") == "ok"


def test_prompt_card_smoke_can_create_missing_board_and_card(tmp_path, monkeypatch):
    sample_project = tmp_path / "sample_project"
    shutil.copytree(WORKAI_SAMPLE, sample_project)
    calls = []

    def fake_run(command, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        calls.append(command)
        stdout = ""
        if command[:2] == ["fizzy", "doctor"]:
            stdout = "ok\n"
        elif command[:3] == ["fizzy", "board", "create"]:
            stdout = json.dumps({"id": "board_auto"})
        elif command[:3] == ["fizzy", "column", "create"]:
            column_name = command[command.index("--name") + 1]
            column_id = f"col_{column_name.lower().replace(' & ', '_').replace(' ', '_')}"
            stdout = json.dumps({"id": column_id})
        elif command[:3] == ["fizzy", "card", "create"]:
            stdout = json.dumps({"id": "card_auto", "number": 321})
        elif command[:3] == ["fizzy", "board", "show"]:
            stdout = json.dumps({"id": "board_auto"})
        elif command[:3] == ["fizzy", "card", "show"]:
            stdout = json.dumps(
                {
                    "id": "card_auto",
                    "number": 321,
                    "title": "Run Codex prompt smoke",
                    "description": "Create prompt-proof.txt",
                    "golden": False,
                    "board": {"id": "board_auto"},
                    "column": {"name": "Ready for Agents"},
                }
            )
        elif command[:3] in (
            ["fizzy", "card", "column"],
            ["fizzy", "comment", "create"],
        ):
            stdout = ""
        else:
            raise AssertionError(f"unexpected command: {command}")
        return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(task_module.subprocess, "run", fake_run)

    summary = run_prompt_card_smoke(
        board_id=None,
        card_number=None,
        prompt="Create prompt-proof.txt",
        workspace=sample_project,
        output_dir=tmp_path / "output",
        runner=_ScriptedPromptSdkRunner(),
        prefer_real_adapter=False,
        live_fizzy=True,
        create_board=True,
        create_card=True,
        board_name="Fizzy Symphony Prompt Smoke",
        card_title="Run Codex prompt smoke",
    )

    assert summary["status"] == "PASS"
    assert summary["board"]["id"] == "board_auto"
    assert summary["board"]["mutated_fizzy"] is True
    assert summary["board"]["cleanup_command"] == "fizzy board delete board_auto"
    assert summary["card_number"] == 321
    assert summary["bootstrap"]["created_board"] is True
    assert summary["bootstrap"]["created_card"] is True
    assert summary["bootstrap"]["handoff_column_id"] == "col_synthesize_verify"
    assert summary["report_back"]["mode"] == "live"
    assert (sample_project / "prompt-proof.txt").read_text(encoding="utf-8") == "ok"
    assert any(call[:3] == ["fizzy", "board", "create"] for call in calls)
    assert any(call[:3] == ["fizzy", "card", "create"] for call in calls)
    assert any(call[:3] == ["fizzy", "comment", "create"] for call in calls)


def test_fizzy_symphony_defaults_to_live_bootstrap_from_small_env(tmp_path, monkeypatch):
    sample_project = tmp_path / "sample_project"
    shutil.copytree(WORKAI_SAMPLE, sample_project)
    calls = _patch_fake_fizzy(monkeypatch)
    monkeypatch.setenv("FIZZY_SYMPHONY_WORKSPACE", str(sample_project))
    monkeypatch.setenv("FIZZY_SYMPHONY_PROMPT", "Create prompt-proof.txt")
    for key in (
        "FIZZY_SYMPHONY_CREATE_BOARD",
        "FIZZY_SYMPHONY_CREATE_CARD",
        "FIZZY_SYMPHONY_LIVE_FIZZY",
        "RC_WORKITEM_ADAPTER",
        "RC_WORKITEM_DB_PATH",
        "RC_WORKITEM_FILES_DIR",
    ):
        monkeypatch.delenv(key, raising=False)

    summary = run_fizzy_symphony_from_environment(
        output_dir=tmp_path / "output",
        runner=_ScriptedPromptSdkRunner(),
        prefer_real_adapter=False,
    )

    assert summary["status"] == "PASS"
    assert summary["board"]["id"] == "board_auto"
    assert summary["bootstrap"]["created_board"] is True
    assert summary["bootstrap"]["created_card"] is True
    assert summary["preflight"]["sqlite_workitems"]["adapter"] == "in-memory"
    assert summary["report_back"]["mode"] == "live"
    assert any(call[:3] == ["fizzy", "board", "create"] for call in calls)


def test_fizzy_symphony_interactive_prompt_can_fill_missing_inputs(tmp_path, monkeypatch):
    sample_project = tmp_path / "sample_project"
    shutil.copytree(WORKAI_SAMPLE, sample_project)
    _patch_fake_fizzy(monkeypatch)
    for key in (
        "FIZZY_SYMPHONY_WORKSPACE",
        "FIZZY_SYMPHONY_PROMPT",
        "FIZZY_SYMPHONY_PROMPT_FILE",
        "FIZZY_SYMPHONY_BOARD_ID",
        "FIZZY_SYMPHONY_CARD_NUMBER",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(task_module, "_can_prompt_interactively", lambda: True)

    def fake_read(label, *, default=None, required=False):  # noqa: ANN001, ARG001
        if label == "Prompt":
            return "Create prompt-proof.txt"
        if label == "Workspace":
            return str(sample_project)
        return default or ""

    monkeypatch.setattr(task_module, "_read_interactive_value", fake_read)

    summary = run_fizzy_symphony_from_environment(
        output_dir=tmp_path / "output",
        runner=_ScriptedPromptSdkRunner(),
        prefer_real_adapter=False,
    )

    assert summary["status"] == "PASS"
    assert summary["workspace"] == str(sample_project.resolve())
    assert (sample_project / "prompt-proof.txt").read_text(encoding="utf-8") == "ok"


def test_fizzy_symphony_can_clone_git_workspace_ref(tmp_path, monkeypatch):
    if shutil.which("git") is None:
        pytest.skip("git is not available")
    source_repo = tmp_path / "source-repo"
    _git(["git", "init", str(source_repo)])
    _git(["git", "-C", str(source_repo), "config", "user.email", "test@example.test"])
    _git(["git", "-C", str(source_repo), "config", "user.name", "Test User"])
    (source_repo / "README.md").write_text("main\n", encoding="utf-8")
    _git(["git", "-C", str(source_repo), "add", "README.md"])
    _git(["git", "-C", str(source_repo), "commit", "-m", "initial"])
    _git(["git", "-C", str(source_repo), "checkout", "-b", "feature"])
    (source_repo / "README.md").write_text("feature\n", encoding="utf-8")
    _git(["git", "-C", str(source_repo), "commit", "-am", "feature"])

    _patch_fake_fizzy(monkeypatch)
    monkeypatch.setenv("FIZZY_SYMPHONY_WORKSPACE", source_repo.as_uri())
    monkeypatch.setenv("FIZZY_SYMPHONY_GIT_REF", "feature")
    monkeypatch.setenv("FIZZY_SYMPHONY_PROMPT", "Create prompt-proof.txt")

    summary = run_fizzy_symphony_from_environment(
        output_dir=tmp_path / "output",
        runner=_ScriptedPromptSdkRunner(),
        prefer_real_adapter=False,
    )

    workspace = Path(summary["workspace"])
    assert summary["status"] == "PASS"
    assert workspace != source_repo
    assert workspace.parent == tmp_path / "output" / "workspaces"
    assert (workspace / "README.md").read_text(encoding="utf-8") == "feature\n"
    assert (workspace / "prompt-proof.txt").read_text(encoding="utf-8") == "ok"


class _ScriptedSdkRunner:
    runner_kind = "codex_sdk"

    def __init__(self) -> None:
        self.card_numbers = []

    def __call__(self, request):
        if request.metadata.get("preflight"):
            return CodexRunResult(
                success=True,
                final_response="SDK preflight OK",
                thread_id="thread-preflight",
                raw_metadata={
                    "runner": "codex_sdk",
                    "thread_id": "thread-preflight",
                    "run_id": "run-preflight",
                    "raw": {"model": "fake-sdk"},
                },
            )

        card_number = int(request.card_number)
        self.card_numbers.append(card_number)
        workspace = Path(str(request.workspace))
        changed_files = _apply_scripted_card_change(workspace, card_number)

        return CodexRunResult(
            success=True,
            final_response=f"Card {card_number} completed with SDK runner.",
            thread_id=f"thread-card-{card_number}",
            artifacts={"changed_files": changed_files},
            validation_summary=f"scripted card {card_number}",
            raw_metadata={
                "runner": "codex_sdk",
                "thread_id": f"thread-card-{card_number}",
                "run_id": f"run-card-{card_number}",
                "card_number": card_number,
                "raw": {"changed_files": changed_files},
            },
        )


class _UnavailableSdkRunner:
    runner_kind = "codex_sdk"

    def __call__(self, request):  # noqa: ARG002
        raise RuntimeError("Codex SDK runner is not implemented yet")


def _patch_fake_fizzy(monkeypatch):
    calls = []
    real_run = subprocess.run

    def fake_run(command, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        if command and command[0] == "git":
            return real_run(command, *args, **kwargs)
        calls.append(command)
        stdout = ""
        if command[:2] == ["fizzy", "doctor"]:
            stdout = "ok\n"
        elif command[:3] == ["fizzy", "board", "create"]:
            stdout = json.dumps({"id": "board_auto"})
        elif command[:3] == ["fizzy", "column", "create"]:
            column_name = command[command.index("--name") + 1]
            column_id = f"col_{column_name.lower().replace(' & ', '_').replace(' ', '_')}"
            stdout = json.dumps({"id": column_id})
        elif command[:3] == ["fizzy", "card", "create"]:
            stdout = json.dumps({"id": "card_auto", "number": 321})
        elif command[:3] == ["fizzy", "board", "show"]:
            stdout = json.dumps({"id": "board_auto"})
        elif command[:3] == ["fizzy", "card", "show"]:
            stdout = json.dumps(
                {
                    "id": "card_auto",
                    "number": 321,
                    "title": "Run Codex prompt smoke",
                    "description": "Create prompt-proof.txt",
                    "golden": False,
                    "board": {"id": "board_auto"},
                    "column": {"name": "Ready for Agents"},
                }
            )
        elif command[:3] in (
            ["fizzy", "card", "column"],
            ["fizzy", "comment", "create"],
        ):
            stdout = ""
        else:
            raise AssertionError(f"unexpected command: {command}")
        return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(task_module.subprocess, "run", fake_run)
    return calls


def _git(command):
    completed = subprocess.run(command, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise AssertionError(completed.stderr or completed.stdout)
    return completed


class _ScriptedPromptSdkRunner(_ScriptedSdkRunner):
    def __call__(self, request):
        if request.metadata.get("preflight"):
            return super().__call__(request)

        card_number = int(request.card_number)
        self.card_numbers.append(card_number)
        workspace = Path(str(request.workspace))
        (workspace / "prompt-proof.txt").write_text("ok", encoding="utf-8")
        return CodexRunResult(
            success=True,
            final_response="Prompt card completed with SDK runner.",
            thread_id=f"thread-card-{card_number}",
            artifacts={"changed_files": ["prompt-proof.txt"]},
            raw_metadata={
                "runner": "codex_sdk",
                "thread_id": f"thread-card-{card_number}",
                "run_id": f"run-card-{card_number}",
                "card_number": card_number,
            },
        )


def _apply_scripted_card_change(workspace: Path, card_number: int):
    changed = []
    cli_path = workspace / "workai_smoke" / "cli.py"
    init_path = workspace / "workai_smoke" / "__init__.py"
    readme_path = workspace / "README.md"
    test_path = workspace / "tests" / "test_cli.py"

    if card_number in {1, 4, 5, 6, 7}:
        cli_path.write_text(_SCRIPTED_CLI, encoding="utf-8")
        changed.append("workai_smoke/cli.py")
    if card_number in {5, 6}:
        init_path.write_text(_SCRIPTED_INIT, encoding="utf-8")
        changed.append("workai_smoke/__init__.py")
    if card_number in {2, 8}:
        text = readme_path.read_text(encoding="utf-8")
        addition = "\n## Usage\n\n```bash\npython -m workai_smoke.cli --json Josh\n```\n"
        checklist = (
            "\n## Smoke completion checklist\n\n"
            "- Code changed\n- Tests passed\n- Fizzy proof reported\n"
        )
        readme_path.write_text(
            text + (addition if card_number == 2 else checklist),
            encoding="utf-8",
        )
        changed.append("README.md")
    if card_number == 3:
        test_path.write_text(_SCRIPTED_TESTS, encoding="utf-8")
        changed.append("tests/test_cli.py")

    proof_path = workspace / f"card-{card_number}-proof.json"
    proof_path.write_text(json.dumps({"card": card_number, "changed": changed}), encoding="utf-8")
    changed.append(proof_path.name)
    return changed


_SCRIPTED_CLI = '''"""Small CLI that smoke-test cards can ask Codex to edit."""

from __future__ import annotations

import argparse
import json
from typing import List

from workai_smoke import __version__


def greeting(name: str) -> str:
    return f"Hello, {name}!"


def farewell(name: str) -> str:
    return f"Goodbye, {name}."


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("name")
    parser.add_argument("--shout", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args(argv)
    message = greeting(args.name)
    if args.shout:
        message = message.upper()
    if args.json:
        print(json.dumps({"name": args.name, "greeting": message}))
    else:
        print(message)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'''

_SCRIPTED_INIT = '''"""Tiny editable package for WorkAI smoke tests."""

__version__ = "0.1.0"

from .cli import farewell, greeting

__all__ = ["__version__", "farewell", "greeting"]
'''

_SCRIPTED_TESTS = '''import json

from workai_smoke.cli import farewell, greeting, main


def test_greeting_includes_name():
    assert "Josh" in greeting("Josh")
    assert greeting("Josh").endswith("!")


def test_farewell_helper():
    assert farewell("Josh") == "Goodbye, Josh."


def test_json_output_mode(capsys):
    assert main(["--json", "Josh"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload == {"name": "Josh", "greeting": "Hello, Josh!"}


def test_shout_mode(capsys):
    assert main(["--shout", "Josh"]) == 0
    assert capsys.readouterr().out == "HELLO, JOSH!\\n"
'''
