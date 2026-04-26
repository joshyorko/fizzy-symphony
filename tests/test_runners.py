import sys

import pytest

from fizzy_symphony.runners import (
    CodexCliRunner,
    CodexRunRequest,
    CodexSdkRunner,
    CodexWorkItemRunner,
    _CodexPythonSdkClient,
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


def test_workitem_runner_can_adapt_sdk_runner_result(tmp_path):
    payload = FizzyWorkItemPayload(
        source="fizzy",
        card={"id": "card-12", "number": 12, "title": "Run SDK payload"},
        workflow={"prompt_template": "SDK payload prompt", "workspace": str(tmp_path)},
        runner={
            "kind": "sdk",
            "model": "gpt-5-codex",
            "approval_policy": "never",
            "timeout_seconds": 12,
        },
    )
    client = _FakeCodexAppServerClient()

    result = CodexWorkItemRunner(CodexSdkRunner(client_factory=lambda **kwargs: client))(payload)

    assert result["success"] is True
    assert result["comment"] == "Final proof text"
    assert result["final_response"] == "Final proof text"
    assert result["thread_id"] == "thread-123"
    assert result["artifacts"]["run_id"] == "turn-456"
    assert result["raw_metadata"]["runner"] == "codex_sdk"
    assert result["raw_metadata"]["card_number"] == 12


class _FakeCodexAppServerClient:
    def __init__(self):
        self.calls = []
        self.closed = False

    def __enter__(self):
        self.calls.append(("enter", None))
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.closed = True
        self.calls.append(("exit", exc_type))

    def initialize(self):
        self.calls.append(("initialize", None))
        return {"userAgent": "codex-cli 0.test", "codexHome": "/tmp/codex-home"}

    def start_thread(self, params):
        self.calls.append(("thread/start", params))
        return {
            "thread": {"id": "thread-123", "cwd": params["cwd"], "status": "running"},
            "model": params["model"],
            "approvalPolicy": params["approvalPolicy"],
        }

    def start_turn(self, params):
        self.calls.append(("turn/start", params))
        return {"turn": {"id": "turn-456", "status": "running", "items": []}}

    def wait_for_turn(self, thread_id, turn_id, timeout_seconds=None):
        self.calls.append(("wait_for_turn", (thread_id, turn_id, timeout_seconds)))
        return {
            "turn": {
                "id": turn_id,
                "status": "completed",
                "items": [
                    {
                        "id": "msg-1",
                        "type": "agentMessage",
                        "text": "Interim note",
                        "phase": "commentary",
                    },
                    {
                        "id": "msg-2",
                        "type": "agentMessage",
                        "text": "Final proof text",
                        "phase": "final_answer",
                    },
                ],
            },
            "notifications": [
                {
                    "method": "agent/message/delta",
                    "params": {
                        "threadId": thread_id,
                        "turnId": turn_id,
                        "delta": "Final proof text",
                    },
                }
            ],
        }


def test_sdk_runner_constructs_without_mandatory_sdk_dependency():
    runner = CodexSdkRunner(command=["codex", "app-server", "--listen", "stdio://"])

    assert runner.command == ["codex", "app-server", "--listen", "stdio://"]


def test_sdk_runner_runs_one_turn_through_app_server_protocol(tmp_path):
    client = _FakeCodexAppServerClient()
    runner = CodexSdkRunner(client_factory=lambda **kwargs: client)
    request = CodexRunRequest(
        prompt="Implement this card",
        workspace=str(tmp_path),
        model="gpt-5-codex",
        approval_policy="never",
        timeout_seconds=12,
        env={"CODEX_HOME": "/tmp/custom-codex-home"},
        card_number=12,
    )

    result = runner(request)

    assert result.success is True
    assert result.final_response == "Final proof text"
    assert result.thread_id == "thread-123"
    assert result.raw_metadata["runner"] == "codex_sdk"
    assert result.raw_metadata["turn_id"] == "turn-456"
    assert result.raw_metadata["app_server"]["initialize"]["userAgent"] == "codex-cli 0.test"
    assert client.closed is True
    assert client.calls[1] == ("initialize", None)
    assert client.calls[2] == (
        "thread/start",
        {
            "cwd": str(tmp_path),
            "model": "gpt-5-codex",
            "approvalPolicy": "never",
            "sandbox": "workspace-write",
            "ephemeral": True,
            "experimentalRawEvents": True,
        },
    )
    assert client.calls[3] == (
        "turn/start",
        {
            "threadId": "thread-123",
            "cwd": str(tmp_path),
            "model": "gpt-5-codex",
            "approvalPolicy": "never",
            "input": [{"type": "text", "text": "Implement this card"}],
            "sandboxPolicy": {
                "type": "workspaceWrite",
                "writableRoots": [str(tmp_path.resolve())],
                "networkAccess": False,
            },
            "responsesapiClientMetadata": {
                "fizzy_symphony.card_number": "12",
                "fizzy_symphony.runner": "codex_sdk",
            },
        },
    )


def test_sdk_runner_uses_agent_message_delta_when_final_item_missing(tmp_path):
    class DeltaOnlyClient(_FakeCodexAppServerClient):
        def wait_for_turn(self, thread_id, turn_id, timeout_seconds=None):
            return {
                "turn": {"id": turn_id, "status": "completed", "items": []},
                "notifications": [
                    {
                        "method": "agent/message/delta",
                        "params": {"threadId": thread_id, "turnId": turn_id, "delta": "Hello "},
                    },
                    {
                        "method": "agent/message/delta",
                        "params": {"threadId": thread_id, "turnId": turn_id, "delta": "there"},
                    },
                ],
            }

    result = CodexSdkRunner(client_factory=lambda **kwargs: DeltaOnlyClient())(
        CodexRunRequest(prompt="Say hi", workspace=str(tmp_path))
    )

    assert result.success is True
    assert result.final_response == "Hello there"


def test_sdk_runner_returns_clean_unavailable_failure(tmp_path):
    def _missing_client(**kwargs):
        raise FileNotFoundError("codex")

    result = CodexSdkRunner(client_factory=_missing_client)(
        CodexRunRequest(prompt="not available", workspace=str(tmp_path))
    )

    assert result.success is False
    assert result.returncode is None
    assert "Codex app-server/SDK unavailable" in result.stderr
    assert result.raw_metadata["error_type"] == "FileNotFoundError"


def test_sdk_runner_returns_clean_runtime_failure(tmp_path):
    class FailingClient(_FakeCodexAppServerClient):
        def start_turn(self, params):
            raise RuntimeError("unauthorized")

    result = CodexSdkRunner(client_factory=lambda **kwargs: FailingClient())(
        CodexRunRequest(prompt="auth blocked", workspace=str(tmp_path))
    )

    assert result.success is False
    assert "Codex app-server/SDK run failed: unauthorized" in result.stderr
    assert result.raw_metadata["error_type"] == "RuntimeError"


def test_python_sdk_client_enforces_timeout_without_blocking():
    class SlowThread:
        def run(self, prompt, **kwargs):  # noqa: ARG002
            import time

            time.sleep(1)

    client = _CodexPythonSdkClient(
        command=["codex", "app-server", "--listen", "stdio://"],
        timeout_seconds=0.01,
    )
    client._thread = SlowThread()
    client._turn_input = "slow"

    with pytest.raises(TimeoutError, match="Codex Python SDK run"):
        client.wait_for_turn("thread-1", "turn-1")


def test_runner_factory_exposes_cli_and_sdk():
    assert isinstance(create_codex_runner("cli"), CodexCliRunner)
    assert isinstance(create_codex_runner("sdk"), CodexSdkRunner)
