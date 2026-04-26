"""Codex runner boundaries for durable Fizzy workers."""

from __future__ import annotations

import json
import os
import queue
import select
import shlex
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Protocol, Sequence, Union

from .workitem_queue import FizzyWorkItemPayload, JSONDict


Command = Union[str, Sequence[str]]


@dataclass(frozen=True)
class CodexRunRequest:
    """Payload-agnostic request for one Codex runner invocation."""

    prompt: str
    command: Optional[Command] = None
    workspace: Optional[str] = None
    model: Optional[str] = None
    approval_policy: Optional[str] = None
    sandbox_mode: Optional[str] = None
    timeout_seconds: Optional[float] = None
    env: Mapping[str, str] = field(default_factory=dict)
    card_number: Optional[int] = None
    metadata: JSONDict = field(default_factory=dict)

    @classmethod
    def from_workitem_payload(cls, payload: FizzyWorkItemPayload) -> "CodexRunRequest":
        """Build a runner request from the stable Fizzy workitem payload."""

        card = payload.card
        workflow = payload.workflow
        runner = payload.runner
        prompt_template = str(workflow.get("prompt_template") or "")
        prompt = prompt_template or str(card.get("description") or card.get("title") or "")

        raw_card_number = card.get("number")
        card_number: Optional[int]
        try:
            card_number = int(raw_card_number) if raw_card_number is not None else None
        except (TypeError, ValueError):
            card_number = None

        timeout_seconds = _optional_float(runner.get("timeout_seconds"))
        env = runner.get("env") or {}
        if not isinstance(env, Mapping):
            env = {}

        metadata = {
            "source": payload.source,
            "card": dict(card),
            "workflow": dict(workflow),
            "runner": dict(runner),
        }

        return cls(
            prompt=prompt,
            command=runner.get("command"),
            workspace=_optional_string(runner.get("workspace") or workflow.get("workspace")),
            model=_optional_string(runner.get("model")),
            approval_policy=_optional_string(runner.get("approval_policy")),
            sandbox_mode=_optional_string(runner.get("sandbox_mode")),
            timeout_seconds=timeout_seconds,
            env={str(key): str(value) for key, value in env.items()},
            card_number=card_number,
            metadata=metadata,
        )


@dataclass(frozen=True)
class CodexRunResult:
    """Structured result from a Codex runner invocation."""

    success: bool
    final_response: str = ""
    stdout: str = ""
    stderr: str = ""
    returncode: Optional[int] = None
    timed_out: bool = False
    thread_id: Optional[str] = None
    artifacts: JSONDict = field(default_factory=dict)
    validation_summary: str = ""
    raw_metadata: JSONDict = field(default_factory=dict)

    def to_workitem_result(self) -> JSONDict:
        """Return a JSON result shape compatible with CodexWorkItemWorker."""

        return {
            "success": self.success,
            "comment": self.final_response,
            "final_response": self.final_response,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "returncode": self.returncode,
            "timed_out": self.timed_out,
            "thread_id": self.thread_id,
            "artifacts": dict(self.artifacts),
            "validation_summary": self.validation_summary,
            "raw_metadata": dict(self.raw_metadata),
        }


class CodexRunner(Protocol):
    """Callable boundary implemented by concrete Codex runners."""

    def __call__(self, request: CodexRunRequest) -> CodexRunResult: ...


Runner = CodexRunner


class CodexAppServerClient(Protocol):
    """Minimal Codex app-server surface used by the optional SDK runner."""

    def __enter__(self) -> "CodexAppServerClient": ...

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None: ...

    def initialize(self) -> JSONDict: ...

    def start_thread(self, params: JSONDict) -> JSONDict: ...

    def start_turn(self, params: JSONDict) -> JSONDict: ...

    def wait_for_turn(
        self,
        thread_id: str,
        turn_id: str,
        timeout_seconds: Optional[float] = None,
    ) -> JSONDict: ...


CodexAppServerClientFactory = Callable[..., CodexAppServerClient]


@dataclass(frozen=True)
class CodexWorkItemRunner:
    """Adapter that lets CodexWorkItemWorker call a request-oriented runner."""

    runner: CodexRunner

    def __call__(self, payload: FizzyWorkItemPayload) -> JSONDict:
        request = CodexRunRequest.from_workitem_payload(payload)
        result = self.runner(request)
        return result.to_workitem_result()


@dataclass(frozen=True)
class CodexCliRunner:
    """Fallback runner that shells out to a configured command."""

    command: Optional[Command] = None
    timeout_seconds: Optional[float] = None
    workspace: Optional[str] = None
    env: Mapping[str, str] = field(default_factory=dict)
    pass_prompt: bool = True

    def __call__(self, request: CodexRunRequest) -> CodexRunResult:
        args = self.build_args(request)
        cwd = request.workspace or self.workspace
        timeout = request.timeout_seconds
        if timeout is None:
            timeout = self.timeout_seconds
        env = self._merged_env(request.env)
        raw_metadata = {
            "runner": "codex_cli",
            "command": list(args),
            "workspace": cwd,
            "timeout_seconds": timeout,
            "card_number": request.card_number,
        }

        try:
            completed = subprocess.run(
                args,
                cwd=cwd,
                env=env,
                text=True,
                capture_output=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            stdout = _coerce_output(exc.stdout)
            stderr = _coerce_output(exc.stderr)
            timeout_message = f"Command timed out after {timeout} seconds."
            if stderr:
                stderr = f"{stderr}\n{timeout_message}"
            else:
                stderr = timeout_message
            return CodexRunResult(
                success=False,
                final_response=stdout,
                stdout=stdout,
                stderr=stderr,
                returncode=None,
                timed_out=True,
                raw_metadata=raw_metadata,
            )

        final_response = completed.stdout.strip()
        return CodexRunResult(
            success=completed.returncode == 0,
            final_response=final_response,
            stdout=completed.stdout,
            stderr=completed.stderr,
            returncode=completed.returncode,
            timed_out=False,
            raw_metadata=raw_metadata,
        )

    def _merged_env(self, request_env: Mapping[str, str]) -> Dict[str, str]:
        env = dict(os.environ)
        env.update({str(key): str(value) for key, value in self.env.items()})
        env.update({str(key): str(value) for key, value in request_env.items()})
        return env

    def build_args(self, request: CodexRunRequest) -> List[str]:
        """Build subprocess arguments, including Codex prompt/config options."""

        command = request.command if request.command is not None else self.command
        if command is None:
            raise ValueError("CodexCliRunner requires a command on the runner or request.")

        args = _normalize_command(command)
        args = _with_codex_exec_options(args, request)
        if self.pass_prompt and request.prompt:
            args.append(request.prompt)
        return args


@dataclass(frozen=True)
class CodexSdkRunner:
    """Optional Codex app-server-backed runner for one-turn worker execution."""

    command: Command = field(
        default_factory=lambda: ["codex", "app-server", "--listen", "stdio://"]
    )
    timeout_seconds: Optional[float] = None
    workspace: Optional[str] = None
    env: Mapping[str, str] = field(default_factory=dict)
    client_factory: Optional[CodexAppServerClientFactory] = None
    ephemeral: bool = True
    experimental_raw_events: bool = True
    sandbox_mode: str = "workspace-write"

    def __call__(self, request: CodexRunRequest) -> CodexRunResult:
        cwd = request.workspace or self.workspace or os.getcwd()
        timeout = request.timeout_seconds
        if timeout is None:
            timeout = self.timeout_seconds
        command = _normalize_command(self.command)
        raw_metadata: JSONDict = {
            "runner": "codex_sdk",
            "protocol": "codex_app_server_jsonrpc_v2",
            "command": command,
            "workspace": cwd,
            "timeout_seconds": timeout,
            "card_number": request.card_number,
        }

        try:
            client = self._make_client(
                command=command,
                timeout_seconds=timeout,
                env=request.env,
            )
            with client as app_server:
                initialize_result = app_server.initialize()
                thread_params = self._thread_start_params(request, cwd)
                thread_start_result = app_server.start_thread(thread_params)
                thread = _mapping_value(thread_start_result, "thread")
                thread_id = _optional_string(thread.get("id"))
                if not thread_id:
                    raise RuntimeError("Codex app-server thread/start did not return a thread id.")

                turn_params = self._turn_start_params(request, cwd, thread_id)
                turn_start_result = app_server.start_turn(turn_params)
                turn = _mapping_value(turn_start_result, "turn")
                turn_id = _optional_string(turn.get("id"))
                if not turn_id:
                    raise RuntimeError("Codex app-server turn/start did not return a turn id.")

                completed_turn = app_server.wait_for_turn(
                    thread_id,
                    turn_id,
                    timeout_seconds=timeout,
                )

            final_response = _extract_final_response(completed_turn)
            turn_result = _mapping_value(completed_turn, "turn")
            actual_turn_id = _optional_string(turn_result.get("id")) or turn_id
            turn_status = _optional_string(turn_result.get("status"))
            success = turn_status in (None, "completed")
            raw_metadata.update(
                {
                    "thread_id": thread_id,
                    "turn_id": actual_turn_id,
                    "run_id": actual_turn_id,
                    "app_server": {
                        "initialize": initialize_result,
                        "thread_start": thread_start_result,
                        "turn_start": turn_start_result,
                        "turn_completed": completed_turn,
                    },
                }
            )
            return CodexRunResult(
                success=success,
                final_response=final_response,
                stderr="" if success else _turn_error_message(turn_result),
                thread_id=thread_id,
                artifacts={"turn_id": actual_turn_id, "run_id": actual_turn_id},
                validation_summary=turn_status or "",
                raw_metadata=raw_metadata,
            )
        except TimeoutError as exc:
            return _sdk_failure_result(
                "Codex app-server/SDK timed out",
                exc,
                raw_metadata,
                timed_out=True,
            )
        except (FileNotFoundError, OSError) as exc:
            return _sdk_failure_result(
                "Codex app-server/SDK unavailable",
                exc,
                raw_metadata,
            )
        except Exception as exc:  # noqa: BLE001 - runner boundary must fail cleanly.
            return _sdk_failure_result(
                "Codex app-server/SDK run failed",
                exc,
                raw_metadata,
            )

    def _make_client(
        self,
        command: Sequence[str],
        timeout_seconds: Optional[float],
        env: Mapping[str, str],
    ) -> CodexAppServerClient:
        merged_env = dict(os.environ)
        merged_env.update({str(key): str(value) for key, value in self.env.items()})
        merged_env.update({str(key): str(value) for key, value in env.items()})
        factory = self.client_factory or _default_codex_app_server_client
        return factory(command=command, timeout_seconds=timeout_seconds, env=merged_env)

    def _thread_start_params(self, request: CodexRunRequest, cwd: str) -> JSONDict:
        return {
            "cwd": cwd,
            "model": request.model,
            "approvalPolicy": request.approval_policy,
            "sandbox": request.sandbox_mode or self.sandbox_mode,
            "ephemeral": self.ephemeral,
            "experimentalRawEvents": self.experimental_raw_events,
        }

    def _turn_start_params(
        self,
        request: CodexRunRequest,
        cwd: str,
        thread_id: str,
    ) -> JSONDict:
        metadata = {
            "fizzy_symphony.runner": "codex_sdk",
        }
        if request.card_number is not None:
            metadata["fizzy_symphony.card_number"] = str(request.card_number)
        return {
            "threadId": thread_id,
            "cwd": cwd,
            "model": request.model,
            "approvalPolicy": request.approval_policy,
            "input": [{"type": "text", "text": request.prompt}],
            "sandboxPolicy": _sandbox_policy(request.sandbox_mode or self.sandbox_mode, cwd),
            "responsesapiClientMetadata": metadata,
        }


def create_codex_runner(kind: str = "cli", **kwargs: object) -> CodexRunner:
    """Create a concrete Codex runner by kind."""

    if kind == "cli":
        return CodexCliRunner(**kwargs)
    if kind == "sdk":
        return CodexSdkRunner(**kwargs)
    raise ValueError(f"unsupported Codex runner kind: {kind!r}")


def _default_codex_app_server_client(**kwargs: object) -> CodexAppServerClient:
    """Prefer the official Python SDK when installed, then fall back to JSON-RPC."""

    try:
        import codex_app_server  # noqa: F401
    except ImportError:
        return _CodexAppServerJsonRpcClient(**kwargs)
    return _CodexPythonSdkClient(**kwargs)


class _CodexPythonSdkClient:
    """Adapter over the official experimental `codex_app_server` Python SDK."""

    def __init__(
        self,
        command: Sequence[str],
        timeout_seconds: Optional[float] = None,
        env: Optional[Mapping[str, str]] = None,
    ) -> None:
        self.command = list(command)
        self.timeout_seconds = timeout_seconds
        self.env = dict(env) if env is not None else {}
        self._codex: object = None
        self._thread: object = None
        self._turn_handle: object = None
        self._turn_input: str = ""
        self._turn_kwargs: JSONDict = {}
        self._old_env: Dict[str, Optional[str]] = {}

    def __enter__(self) -> "_CodexPythonSdkClient":
        self._old_env = {key: os.environ.get(key) for key in self.env}
        os.environ.update(self.env)
        from codex_app_server import AppServerConfig, Codex

        codex_bin = shutil.which(self.command[0]) or (self.command[0] if self.command else None)
        self._codex = Codex(
            AppServerConfig(
                codex_bin=codex_bin,
                env=dict(self.env) if self.env else None,
                client_name="fizzy-symphony",
                client_title="Fizzy Symphony",
                client_version="0.1.0",
                experimental_api=True,
            )
        )
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        close = getattr(self._codex, "close", None)
        if callable(close):
            close()
        for key, value in self._old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def initialize(self) -> JSONDict:
        metadata = getattr(self._codex, "metadata", None)
        return _json_dict(metadata)

    def start_thread(self, params: JSONDict) -> JSONDict:
        codex = self._require_codex()
        kwargs = {
            "cwd": params.get("cwd"),
            "model": params.get("model"),
            "approval_policy": params.get("approvalPolicy"),
            "ephemeral": params.get("ephemeral"),
            "config": params.get("config"),
            "sandbox": params.get("sandbox"),
        }
        self._thread = codex.thread_start(**{key: value for key, value in kwargs.items() if value is not None})
        thread_data = _json_dict(self._thread)
        thread_id = _optional_string(thread_data.get("id") or getattr(self._thread, "id", None))
        if thread_id:
            thread_data["id"] = thread_id
        return {"thread": thread_data}

    def start_turn(self, params: JSONDict) -> JSONDict:
        thread = self._require_thread()
        self._turn_input = _text_from_sdk_input(params.get("input"))
        kwargs = {
            "cwd": params.get("cwd"),
            "model": params.get("model"),
            "approval_policy": params.get("approvalPolicy"),
            "sandbox_policy": params.get("sandboxPolicy"),
        }
        clean_kwargs = {key: value for key, value in kwargs.items() if value is not None}
        self._turn_kwargs = dict(clean_kwargs)
        self._turn_handle = None
        return {"turn": {"id": "python-sdk-run-pending", "status": "inProgress", "items": []}}

    def wait_for_turn(
        self,
        thread_id: str,  # noqa: ARG002 - Python SDK thread object already owns it.
        turn_id: str,
        timeout_seconds: Optional[float] = None,
    ) -> JSONDict:
        effective_timeout = (
            timeout_seconds if timeout_seconds is not None else self.timeout_seconds
        )
        if self._turn_handle is not None:
            turn = _call_with_timeout(self._turn_handle.run, effective_timeout)
            turn_data = _json_dict(turn)
            if not turn_data.get("id"):
                turn_data["id"] = turn_id
            if not turn_data.get("status"):
                turn_data["status"] = "completed"
            return {"turn": turn_data, "notifications": []}

        thread = self._require_thread()
        result = _call_with_timeout(
            lambda: thread.run(self._turn_input, **self._turn_kwargs),
            effective_timeout,
        )
        final_response = getattr(result, "final_response", None)
        raw_items = getattr(result, "items", [])
        items = _json_value(raw_items) if isinstance(raw_items, list) else []
        if final_response and not items:
            items = [
                {
                    "id": "python-sdk-final-response",
                    "type": "agentMessage",
                    "text": str(final_response),
                    "phase": "final_answer",
                }
            ]
        resolved_turn_id = turn_id
        if turn_id == "python-sdk-run-pending" and items:
            last_item = items[-1]
            if isinstance(last_item, Mapping) and last_item.get("id"):
                resolved_turn_id = f"python-sdk-run-{last_item['id']}"
        return {
            "turn": {
                "id": resolved_turn_id,
                "status": "completed",
                "items": items,
            },
            "notifications": [],
            "usage": _json_value(getattr(result, "usage", None)),
        }

    def _require_codex(self):
        if self._codex is None:
            raise RuntimeError("Codex Python SDK client has not started.")
        return self._codex

    def _require_thread(self):
        if self._thread is None:
            raise RuntimeError("Codex Python SDK thread has not started.")
        return self._thread


class _CodexAppServerJsonRpcClient:
    """Line-delimited JSON-RPC client for `codex app-server --listen stdio://`."""

    def __init__(
        self,
        command: Sequence[str],
        timeout_seconds: Optional[float] = None,
        env: Optional[Mapping[str, str]] = None,
    ) -> None:
        self.command = list(command)
        self.timeout_seconds = timeout_seconds
        self.env = dict(env) if env is not None else None
        self._process: Optional[subprocess.Popen[str]] = None
        self._next_id = 1
        self._notifications: List[JSONDict] = []

    def __enter__(self) -> "_CodexAppServerJsonRpcClient":
        self._process = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=self.env,
        )
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        process = self._require_process()
        if process.stdin:
            process.stdin.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    def initialize(self) -> JSONDict:
        result = self._request(
            "initialize",
            {
                "clientInfo": {
                    "name": "fizzy-symphony",
                    "version": "0.1.0",
                },
                "capabilities": {"experimentalApi": True},
            },
        )
        self._notification("initialized")
        return result

    def start_thread(self, params: JSONDict) -> JSONDict:
        return self._request("thread/start", params)

    def start_turn(self, params: JSONDict) -> JSONDict:
        return self._request("turn/start", params)

    def wait_for_turn(
        self,
        thread_id: str,
        turn_id: str,
        timeout_seconds: Optional[float] = None,
    ) -> JSONDict:
        effective_timeout = (
            timeout_seconds if timeout_seconds is not None else self.timeout_seconds
        )
        deadline = _deadline(effective_timeout)
        notifications: List[JSONDict] = list(self._notifications)
        final_items: List[JSONDict] = []
        self._notifications.clear()
        while True:
            message = self._read_message(deadline)
            if "id" in message and "method" in message:
                raise RuntimeError(
                    f"Codex app-server requested unsupported interactive method "
                    f"{message.get('method')!r}."
                )
            if "method" not in message:
                continue
            notifications.append(message)
            method = message.get("method")
            params = _mapping_value(message, "params")
            if method == "error":
                raise RuntimeError(str(params.get("message") or params))
            if (
                method == "item/completed"
                and params.get("threadId") == thread_id
                and params.get("turnId") == turn_id
            ):
                item = _mapping_value(params, "item")
                if item.get("type") == "agentMessage":
                    final_items.append(item)
            if method == "turn/completed" and params.get("threadId") == thread_id:
                turn = _mapping_value(params, "turn")
                if turn.get("id") == turn_id:
                    if final_items and not turn.get("items"):
                        turn["items"] = final_items
                    return {"turn": dict(turn), "notifications": notifications}
            if method == "thread/status/changed" and params.get("threadId") == thread_id:
                status = _mapping_value(params, "status")
                if final_items and status.get("type") == "idle":
                    return {
                        "turn": {
                            "id": turn_id,
                            "status": "completed",
                            "items": final_items,
                        },
                        "notifications": notifications,
                    }

    def _request(self, method: str, params: JSONDict) -> JSONDict:
        request_id = self._next_id
        self._next_id += 1
        self._write_message(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }
        )
        deadline = _deadline(self.timeout_seconds)
        while True:
            message = self._read_message(deadline)
            if message.get("id") == request_id:
                if "error" in message:
                    error = _mapping_value(message, "error")
                    raise RuntimeError(str(error.get("message") or error))
                result = message.get("result")
                if isinstance(result, Mapping):
                    return dict(result)
                return {}
            if "method" in message:
                self._notifications.append(message)

    def _write_message(self, message: JSONDict) -> None:
        process = self._require_process()
        if process.stdin is None:
            raise RuntimeError("Codex app-server stdin is unavailable.")
        process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        process.stdin.flush()

    def _notification(self, method: str, params: Optional[JSONDict] = None) -> None:
        message: JSONDict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._write_message(message)

    def _read_message(self, deadline: Optional[float]) -> JSONDict:
        process = self._require_process()
        if process.stdout is None:
            raise RuntimeError("Codex app-server stdout is unavailable.")
        wait_seconds = _seconds_until(deadline)
        ready, _, _ = select.select([process.stdout], [], [], wait_seconds)
        if not ready:
            raise TimeoutError("Timed out waiting for Codex app-server response.")
        line = process.stdout.readline()
        if line == "":
            stderr = _read_completed_stderr(process)
            raise RuntimeError(f"Codex app-server exited before responding. {stderr}".strip())
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Codex app-server emitted invalid JSON: {line.strip()}") from exc
        if not isinstance(message, Mapping):
            raise RuntimeError(f"Codex app-server emitted non-object JSON: {message!r}")
        return dict(message)

    def _require_process(self) -> subprocess.Popen[str]:
        if self._process is None:
            raise RuntimeError("Codex app-server process has not started.")
        return self._process


def _normalize_command(command: Command) -> List[str]:
    if isinstance(command, str):
        return shlex.split(command)
    return [str(part) for part in command]


def _with_codex_exec_options(args: List[str], request: CodexRunRequest) -> List[str]:
    if not _is_codex_exec(args):
        return args

    resolved = list(args)
    if request.model and "--model" not in resolved and "-m" not in resolved:
        resolved.extend(["--model", request.model])
    if request.approval_policy:
        resolved.extend(["-c", f"approval_policy={request.approval_policy!r}"])
    if request.workspace and "--cd" not in resolved and "-C" not in resolved:
        resolved.extend(["--cd", request.workspace])
    return resolved


def _is_codex_exec(args: Sequence[str]) -> bool:
    if len(args) < 2:
        return False
    executable = Path(args[0]).name
    return executable == "codex" and args[1] == "exec"


def _sdk_failure_result(
    prefix: str,
    exc: BaseException,
    raw_metadata: JSONDict,
    timed_out: bool = False,
) -> CodexRunResult:
    raw_metadata.update(
        {
            "error_type": type(exc).__name__,
            "error": str(exc),
        }
    )
    return CodexRunResult(
        success=False,
        stderr=f"{prefix}: {exc}",
        returncode=None,
        timed_out=timed_out,
        raw_metadata=raw_metadata,
    )


def _mapping_value(mapping: Mapping[str, object], key: str) -> JSONDict:
    value = mapping.get(key)
    if isinstance(value, Mapping):
        return dict(value)
    return {}


def _json_dict(value: object) -> JSONDict:
    if value is None:
        return {}
    if isinstance(value, Mapping):
        return {str(key): _json_value(nested) for key, nested in value.items()}
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump(mode="json", by_alias=True, exclude_none=True)
        if isinstance(dumped, Mapping):
            return {str(key): _json_value(nested) for key, nested in dumped.items()}
    if hasattr(value, "__dict__"):
        return {
            str(key): _json_value(nested)
            for key, nested in vars(value).items()
            if not key.startswith("_")
        }
    return {}


def _json_value(value: object) -> object:
    if isinstance(value, Mapping):
        return {str(key): _json_value(nested) for key, nested in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, tuple):
        return [_json_value(item) for item in value]
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return model_dump(mode="json", by_alias=True, exclude_none=True)
    if hasattr(value, "__dict__") and not isinstance(value, (str, bytes)):
        return _json_dict(value)
    return value


def _text_from_sdk_input(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, Mapping) and item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
        return "\n".join(part for part in parts if part)
    if isinstance(value, Mapping) and value.get("type") == "text":
        return str(value.get("text") or "")
    return str(value or "")


def _sandbox_policy(mode: Optional[str], cwd: str) -> Optional[JSONDict]:
    if mode is None:
        return None
    if mode == "workspace-write":
        return {
            "type": "workspaceWrite",
            "writableRoots": [str(Path(cwd).resolve())],
            "networkAccess": False,
        }
    if mode == "read-only":
        return {"type": "readOnly"}
    if mode == "danger-full-access":
        return {"type": "dangerFullAccess"}
    return None


def _extract_final_response(payload: JSONDict) -> str:
    turn = _mapping_value(payload, "turn")
    items = turn.get("items")
    if isinstance(items, list):
        final_messages = [
            str(item.get("text") or "")
            for item in items
            if isinstance(item, Mapping)
            and item.get("type") == "agentMessage"
            and item.get("phase") == "final_answer"
            and item.get("text")
        ]
        if final_messages:
            return final_messages[-1].strip()

        agent_messages = [
            str(item.get("text") or "")
            for item in items
            if isinstance(item, Mapping)
            and item.get("type") == "agentMessage"
            and item.get("text")
        ]
        if agent_messages:
            return agent_messages[-1].strip()

    notifications = payload.get("notifications")
    if isinstance(notifications, list):
        deltas = []
        for notification in notifications:
            if not isinstance(notification, Mapping):
                continue
            if notification.get("method") not in (
                "item/agentMessage/delta",
                "agent/message/delta",
            ):
                continue
            params = notification.get("params")
            if isinstance(params, Mapping) and params.get("delta"):
                deltas.append(str(params["delta"]))
        if deltas:
            return "".join(deltas).strip()

    return ""


def _turn_error_message(turn: Mapping[str, object]) -> str:
    error = turn.get("error")
    if isinstance(error, Mapping):
        message = error.get("message")
        if message:
            return str(message)
    if error:
        return str(error)
    status = _optional_string(turn.get("status")) or "unknown"
    return f"Codex turn finished with status {status!r}."


def _deadline(timeout_seconds: Optional[float]) -> Optional[float]:
    if timeout_seconds is None:
        return None
    return time.monotonic() + timeout_seconds


def _seconds_until(deadline: Optional[float]) -> Optional[float]:
    if deadline is None:
        return None
    return max(0.0, deadline - time.monotonic())


def _read_completed_stderr(process: subprocess.Popen[str]) -> str:
    if process.poll() is None or process.stderr is None:
        return ""
    return process.stderr.read().strip()


def _optional_string(value: object) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    return text or None


def _optional_float(value: object) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_output(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return str(value)


def _call_with_timeout(call: Callable[[], object], timeout_seconds: Optional[float]) -> object:
    if timeout_seconds is None:
        return call()

    results: "queue.Queue[tuple[bool, object]]" = queue.Queue(maxsize=1)

    def run_call() -> None:
        try:
            results.put((True, call()))
        except BaseException as exc:  # noqa: BLE001 - re-raised at runner boundary.
            results.put((False, exc))

    worker = threading.Thread(target=run_call, daemon=True)
    worker.start()
    worker.join(timeout_seconds)
    if worker.is_alive():
        raise TimeoutError("Timed out waiting for Codex Python SDK run.")

    succeeded, value = results.get_nowait()
    if succeeded:
        return value
    raise value
