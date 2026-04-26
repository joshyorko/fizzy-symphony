import sys

import pytest

from fizzy_symphony.runners import (
    CodexCliRunner,
    CodexRunRequest,
    CodexSdkRunner,
    CodexWorkItemRunner,
    create_codex_runner,
)
from fizzy_symphony.workitem_queue import FizzyWorkItemPayload


def _python_snippet(source):
    return [sys.executable, "-c", source]


def test_request_can_be_built_from_workitem_payload():
    payload = FizzyWorkItemPayload(
        source="fizzy",
        card={
            "id": "card-12",
            "number": "12",
            "title": "Wire Codex runner",
            "description": "Use the runner boundary",
        },
        workflow={
            "prompt_template": "Implement issue 12",
            "allowed_paths": ["src/fizzy_symphony/runners.py"],
            "workspace": "/tmp/fizzy-workspace",
        },
        runner={
            "kind": "codex",
            "command": "codex exec --json",
            "model": "gpt-5-codex",
            "approval_policy": "never",
            "timeout_seconds": "7",
            "env": {"CODEX_HOME": "/tmp/codex-home"},
        },
    )

    request = CodexRunRequest.from_workitem_payload(payload)

    assert request.prompt == "Implement issue 12"
    assert request.command == "codex exec --json"
    assert request.workspace == "/tmp/fizzy-workspace"
    assert request.model == "gpt-5-codex"
    assert request.approval_policy == "never"
    assert request.timeout_seconds == 7.0
    assert request.env == {"CODEX_HOME": "/tmp/codex-home"}
    assert request.card_number == 12
    assert request.metadata["card"]["title"] == "Wire Codex runner"


def test_cli_runner_returns_successful_subprocess_result(tmp_path):
    request = CodexRunRequest(
        prompt="safe local run",
        command=_python_snippet(
            "from pathlib import Path; "
            "Path('proof.txt').write_text('ok'); "
            "print('runner completed')"
        ),
        workspace=str(tmp_path),
        env={"FIZZY_TEST_VALUE": "present"},
    )

    result = CodexCliRunner()(request)

    assert result.success is True
    assert result.returncode == 0
    assert result.stdout == "runner completed\n"
    assert result.stderr == ""
    assert result.final_response == "runner completed"
    assert result.raw_metadata["workspace"] == str(tmp_path)
    assert (tmp_path / "proof.txt").read_text() == "ok"


def test_cli_runner_passes_prompt_to_subprocess():
    request = CodexRunRequest(
        prompt="prompt from card",
        command=_python_snippet("import sys; print(sys.argv[-1])"),
    )

    result = CodexCliRunner()(request)

    assert result.success is True
    assert result.final_response == "prompt from card"


def test_cli_runner_applies_codex_exec_options_without_running_codex():
    request = CodexRunRequest(
        prompt="work this card",
        command="codex exec --json",
        workspace="/tmp/workai-smoke",
        model="gpt-5-codex",
        approval_policy="never",
    )

    args = CodexCliRunner().build_args(request)

    assert args == [
        "codex",
        "exec",
        "--json",
        "--model",
        "gpt-5-codex",
        "-c",
        "approval_policy='never'",
        "--cd",
        "/tmp/workai-smoke",
        "work this card",
    ]


def test_cli_runner_returns_failed_subprocess_result_without_raising():
    request = CodexRunRequest(
        prompt="safe local failure",
        command=_python_snippet("import sys; print('bad stderr', file=sys.stderr); sys.exit(23)"),
    )

    result = CodexCliRunner()(request)

    assert result.success is False
    assert result.returncode == 23
    assert result.stderr == "bad stderr\n"
    assert result.timed_out is False


def test_cli_runner_preserves_env_overlay():
    request = CodexRunRequest(
        prompt="safe env run",
        command=_python_snippet("import os; print(os.environ['FIZZY_RUNNER_ENV'])"),
        env={"FIZZY_RUNNER_ENV": "from-request"},
    )

    result = CodexCliRunner(env={"FIZZY_RUNNER_ENV": "from-runner"})(request)

    assert result.success is True
    assert result.final_response == "from-request"


def test_cli_runner_timeout_returns_structured_failure():
    request = CodexRunRequest(
        prompt="safe timeout",
        command=_python_snippet("import time; time.sleep(2)"),
        timeout_seconds=0.1,
    )

    result = CodexCliRunner()(request)

    assert result.success is False
    assert result.returncode is None
    assert result.timed_out is True
    assert "timed out" in result.stderr


def test_workitem_runner_adapts_payload_to_worker_result():
    payload = FizzyWorkItemPayload(
        source="fizzy",
        card={"id": "card-44", "number": 44, "title": "Run payload adapter"},
        workflow={"prompt_template": "Smoke prompt"},
        runner={
            "command": _python_snippet("print('payload runner completed')"),
        },
    )

    result = CodexWorkItemRunner(CodexCliRunner())(payload)

    assert result["success"] is True
    assert result["comment"] == "payload runner completed"
    assert result["final_response"] == "payload runner completed"
    assert result["returncode"] == 0
    assert result["raw_metadata"]["card_number"] == 44


def test_sdk_runner_placeholder_fails_clearly():
    runner = CodexSdkRunner()

    with pytest.raises(RuntimeError, match="Codex SDK runner is not implemented yet"):
        runner(CodexRunRequest(prompt="not yet"))


def test_runner_factory_exposes_cli_and_rejects_unimplemented_sdk():
    assert isinstance(create_codex_runner("cli"), CodexCliRunner)

    with pytest.raises(RuntimeError, match="Codex SDK runner is not implemented yet"):
        create_codex_runner("sdk")
