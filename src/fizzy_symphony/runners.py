"""Codex runner boundaries for durable Fizzy workers."""

from __future__ import annotations

import os
import shlex
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Protocol, Sequence, Union

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


class CodexSdkRunner:
    """Placeholder for the future official Codex SDK runner."""

    def __call__(self, request: CodexRunRequest) -> CodexRunResult:  # noqa: ARG002
        raise RuntimeError(
            "Codex SDK runner is not implemented yet. Use CodexCliRunner until the "
            "optional SDK/app-server integration is proven locally."
        )


def create_codex_runner(kind: str = "cli", **kwargs: object) -> CodexRunner:
    """Create a concrete Codex runner by kind."""

    if kind == "cli":
        return CodexCliRunner(**kwargs)
    if kind == "sdk":
        raise RuntimeError(
            "Codex SDK runner is not implemented yet. Use CodexCliRunner until the "
            "optional SDK/app-server integration is proven locally."
        )
    raise ValueError(f"unsupported Codex runner kind: {kind!r}")


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
