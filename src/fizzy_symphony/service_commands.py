"""Operator command helpers for the Fizzy Symphony service surface."""

from __future__ import annotations

import json
import os
import signal
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

from .live_fizzy import (
    FIZZY_TIMEOUT_ENV,
    fizzy_timeout_seconds_from_environment,
)


JSONDict = Dict[str, Any]

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_DIR = ".fizzy-symphony"
DEFAULT_CONFIG_FILE = "config.json"
DEFAULT_ENV_FILE = "env.json"
DEFAULT_RUN_FILE = "run.json"
DEFAULT_LOG_FILE = "service.log"
DEFAULT_ROBOT_PATH = "robots/workitems/robot.yaml"
DEFAULT_OUTPUT_DIR = ".fizzy-symphony/output"
DEFAULT_TASK = "FizzySymphony"
DEFAULT_WORKSPACE = "tmp/rails-todo-live"
DEFAULT_PROMPT_FILE = "devdata/rails-todo.prompt.md"
DEFAULT_BOARD_NAME = "Fizzy Symphony Rails Todo"
DEFAULT_CARD_TITLE = "Build a simple Rails todo app"
DEFAULT_CODEX_MODEL = "gpt-5.4-mini"
DEFAULT_RESULT_QUEUE_NAME = "fizzy_codex_results"
DEFAULT_FIZZY_TIMEOUT_VALUE = "30"


def setup_command(args: object) -> int:
    """Create local service config and env files."""

    config_dir = _config_dir(args)
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / DEFAULT_CONFIG_FILE
    env_path = config_dir / DEFAULT_ENV_FILE
    existing_config = _read_json(config_path)
    existing_env = _read_json(env_path)

    config = {
        "created_at": _now_iso(),
        "rcc_bin": str(getattr(args, "rcc_bin", "rcc") or "rcc"),
        "robot_path": str(getattr(args, "robot_path", DEFAULT_ROBOT_PATH) or DEFAULT_ROBOT_PATH),
        "task": DEFAULT_TASK,
        "output_dir": str(_setup_output_dir(args, config_dir, existing_config)),
    }
    env = _build_env(args, existing_env)

    _write_json(config_path, config)
    _write_json(env_path, env)

    print(f"Config written: {config_path}")
    print(f"Env written   : {env_path}")
    print("")
    print("Start watching:")
    print(f"  fizzy-symphony start --config-dir {config_dir}")
    print("Check status:")
    print(f"  fizzy-symphony status --config-dir {config_dir}")
    return 0


def start_command(args: object) -> int:
    """Start the RCC-backed service, detached by default."""

    config_dir = _config_dir(args)
    config = _load_config(config_dir)
    env_path = config_dir / DEFAULT_ENV_FILE
    if not env_path.is_file():
        print(f"error: missing env file: {env_path}", file=sys.stderr)
        return 2

    foreground = bool(getattr(args, "foreground", False))
    command = _rcc_command(
        config,
        env_path,
        silent=foreground and not bool(getattr(args, "verbose", False)),
    )
    if bool(getattr(args, "dry_run", False)):
        print(" ".join(command))
        return 0

    if not foreground:
        return _start_detached(config_dir, command)

    print("Starting Fizzy Symphony watcher in foreground. Press Ctrl-C to stop.")
    print(" ".join(command))
    return subprocess.run(command, check=False).returncode


def status_command(args: object) -> int:
    """Print process, latest artifact, and queue status."""

    config_dir = _config_dir(args)
    config = _load_config(config_dir, required=False)
    run_state = _read_json(config_dir / DEFAULT_RUN_FILE)
    output_dir, status = _latest_status(config)
    queue = _queue_summary(output_dir / "fizzy-symphony-smoke.db") if output_dir else []

    process = _process_status(run_state)
    effective_status = _effective_status(status, process)

    if bool(getattr(args, "json", False)):
        print(
            json.dumps(
                {
                    "process": process,
                    "run": run_state,
                    "status": status,
                    "effective_status": effective_status,
                    "queue": queue,
                    "config": config,
                    "artifact_dir": str(output_dir) if output_dir else "",
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0

    print("Fizzy Symphony Status")
    print(f"process: {process['state']}" + (f" pid={process['pid']}" if process.get("pid") else ""))
    if run_state.get("log_path"):
        print(f"log: {run_state['log_path']}")
    if status:
        print(f"status: {effective_status}")
        if status.get("phase"):
            print(f"phase: {status['phase']}")
        if status.get("board_id"):
            print(f"board: {status['board_id']}")
        if status.get("card_number"):
            print(f"card: {status['card_number']}")
        worker = status.get("worker") if isinstance(status.get("worker"), Mapping) else {}
        if worker:
            worker_state = worker.get("state") or "unknown"
            worker_input_id = worker.get("input_id") or ""
            print(f"worker: {worker_state}" + (f" input={worker_input_id}" if worker_input_id else ""))
        sdk = status.get("sdk") if isinstance(status.get("sdk"), Mapping) else {}
        if sdk:
            print(f"sdk thread: {sdk.get('thread_id') or sdk.get('preflight_thread_id') or ''}")
            print(f"sdk run: {sdk.get('run_id') or sdk.get('preflight_run_id') or ''}")
        if status.get("heartbeat_at"):
            print(f"heartbeat: {status['heartbeat_at']}")
        if status.get("summary_path"):
            print(f"summary: {status['summary_path']}")
    else:
        print("status: no status artifact yet")
    if queue:
        print("queue:")
        for item in queue:
            print(
                f"  {item['queue_name']} {_queue_state_label(item)}: {item['count']}"
            )
    return 0


def boards_command(args: object) -> int:
    """List Fizzy boards, then configured board columns when available."""

    fizzy_bin = str(getattr(args, "fizzy_bin", "fizzy") or "fizzy")
    try:
        timeout_seconds = fizzy_timeout_seconds_from_environment()
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    command = [fizzy_bin, "board", "list", "--markdown"]
    completed = _run_fizzy_cli(command, timeout_seconds=timeout_seconds)
    if completed.returncode != 0:
        print(completed.stderr or completed.stdout or "fizzy board list failed", file=sys.stderr)
        return completed.returncode
    print(completed.stdout, end="")

    board_ids = _configured_board_ids(_config_dir(args))
    for board_id in board_ids:
        column_command = [fizzy_bin, "column", "list", "--board", board_id, "--markdown"]
        columns = _run_fizzy_cli(column_command, timeout_seconds=timeout_seconds)
        if columns.returncode == 0 and columns.stdout:
            print("")
            print(columns.stdout, end="")
    return 0


def stop_command(args: object) -> int:
    """Stop a detached service process if one is recorded."""

    config_dir = _config_dir(args)
    run_path = config_dir / DEFAULT_RUN_FILE
    run_state = _read_json(run_path)
    pid = _int_or_none(run_state.get("pid"))
    if pid is None:
        print("No recorded Fizzy Symphony process.")
        return 0
    if not _pid_alive(pid):
        print(f"Fizzy Symphony process already stopped: {pid}")
        return 0
    os.kill(pid, signal.SIGTERM)
    print(f"Stopped Fizzy Symphony process: {pid}")
    return 0


def default_command(config_dir: Optional[str] = None) -> str:
    """Return the no-argument command name."""

    directory = Path(config_dir or DEFAULT_CONFIG_DIR)
    if (directory / DEFAULT_CONFIG_FILE).is_file() and (directory / DEFAULT_ENV_FILE).is_file():
        return "start"
    return "setup"


def _build_env(args: object, existing_env: Optional[Mapping[str, Any]] = None) -> JSONDict:
    existing_env = existing_env or {}
    workspace = _workspace_setup_value(args, existing_env)
    prompt = _setup_value(args, "prompt", existing_env, "FIZZY_SYMPHONY_PROMPT", "")
    prompt_file = _setup_value(
        args,
        "prompt_file",
        existing_env,
        "FIZZY_SYMPHONY_PROMPT_FILE",
        DEFAULT_PROMPT_FILE,
    )
    env: JSONDict = {
        str(key): str(value)
        for key, value in existing_env.items()
        if str(value) != ""
    }
    env.update(
        {
            "FIZZY_SYMPHONY_WORKSPACE": workspace,
            "FIZZY_SYMPHONY_PROMPT": prompt,
            "FIZZY_SYMPHONY_PROMPT_FILE": prompt_file,
            "FIZZY_SYMPHONY_BOARD_NAME": _setup_value(
                args,
                "board_name",
                existing_env,
                "FIZZY_SYMPHONY_BOARD_NAME",
                DEFAULT_BOARD_NAME,
            ),
            "FIZZY_SYMPHONY_CARD_TITLE": _setup_value(
                args,
                "card_title",
                existing_env,
                "FIZZY_SYMPHONY_CARD_TITLE",
                DEFAULT_CARD_TITLE,
            ),
            "FIZZY_SYMPHONY_CODEX_MODEL": _setup_value(
                args,
                "codex_model",
                existing_env,
                "FIZZY_SYMPHONY_CODEX_MODEL",
                DEFAULT_CODEX_MODEL,
            ),
            "FIZZY_SYMPHONY_RUN_MODE": _setup_value(
                args,
                "run_mode",
                existing_env,
                "FIZZY_SYMPHONY_RUN_MODE",
                "once",
            ),
            FIZZY_TIMEOUT_ENV: _setup_value(
                args,
                "fizzy_timeout_seconds",
                existing_env,
                FIZZY_TIMEOUT_ENV,
                DEFAULT_FIZZY_TIMEOUT_VALUE,
            ),
            "FIZZY_SYMPHONY_BOARD_ID": _setup_value(
                args,
                "board_id",
                existing_env,
                "FIZZY_SYMPHONY_BOARD_ID",
                "",
            ),
            "FIZZY_SYMPHONY_CARD_NUMBER": _setup_value(
                args,
                "card_number",
                existing_env,
                "FIZZY_SYMPHONY_CARD_NUMBER",
                "",
            ),
        }
    )
    return {key: value for key, value in env.items() if value != "" or key in {"FIZZY_SYMPHONY_BOARD_ID", "FIZZY_SYMPHONY_CARD_NUMBER"}}


def _run_fizzy_cli(command: List[str], *, timeout_seconds: float) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(
            command,
            124,
            stdout="",
            stderr=f"{' '.join(command)} timed out after {timeout_seconds:g} seconds.",
        )


def _rcc_command(config: Mapping[str, Any], env_path: Path, *, silent: bool) -> List[str]:
    command = [
        str(config.get("rcc_bin") or "rcc"),
        "run",
        "-r",
        str(config.get("robot_path") or DEFAULT_ROBOT_PATH),
        "-t",
        str(config.get("task") or DEFAULT_TASK),
        "-e",
        str(env_path),
    ]
    if silent:
        command.append("--silent")
    return command


def _start_detached(config_dir: Path, command: Sequence[str]) -> int:
    log_path = config_dir / DEFAULT_LOG_FILE
    log_file = log_path.open("wb")
    process = subprocess.Popen(
        list(command),
        stdout=log_file,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    run_path = config_dir / DEFAULT_RUN_FILE
    _write_json(
        run_path,
        {
            "pid": process.pid,
            "started_at": _now_iso(),
            "command": list(command),
            "log_path": str(log_path),
        },
    )
    print(f"Started Fizzy Symphony: pid={process.pid}")
    print(f"Log: {log_path}")
    print(f"Status: fizzy-symphony status --config-dir {config_dir}")
    return 0


def _config_dir(args: object) -> Path:
    return Path(str(getattr(args, "config_dir", None) or DEFAULT_CONFIG_DIR))


def _setup_output_dir(
    args: object,
    config_dir: Path,
    existing_config: Optional[Mapping[str, Any]] = None,
) -> Path:
    raw_output_dir = str(getattr(args, "output_dir", "") or "")
    if raw_output_dir:
        return Path(raw_output_dir)
    existing_output_dir = str((existing_config or {}).get("output_dir") or "")
    return Path(existing_output_dir) if existing_output_dir else config_dir / "output"


def _setup_value(
    args: object,
    attribute: str,
    existing_env: Mapping[str, Any],
    env_key: str,
    default: str,
) -> str:
    explicit = str(getattr(args, attribute, "") or "")
    if explicit:
        return explicit
    existing = str(existing_env.get(env_key) or "")
    return existing or default


def _workspace_setup_value(args: object, existing_env: Mapping[str, Any]) -> str:
    workspace = _setup_value(
        args,
        "workspace",
        existing_env,
        "FIZZY_SYMPHONY_WORKSPACE",
        DEFAULT_WORKSPACE,
    )
    return _resolve_workspace_for_env(workspace)


def _resolve_workspace_for_env(workspace: str) -> str:
    value = str(workspace or "").strip()
    if not value or _looks_like_git_workspace(value):
        return value
    path = Path(value).expanduser()
    if path.is_absolute():
        return str(path)
    return str((REPO_ROOT / path).resolve())


def _looks_like_git_workspace(value: str) -> bool:
    return (
        value.startswith(("http://", "https://", "ssh://", "git@"))
        or value.endswith(".git")
    )


def _latest_status(config: Mapping[str, Any]) -> tuple[Optional[Path], JSONDict]:
    for output_dir in _candidate_output_dirs(config):
        status = _read_json(output_dir / "fizzy-symphony-status.json")
        if status:
            return output_dir, status
    first_output_dir = next(iter(_candidate_output_dirs(config)), None)
    return first_output_dir, {}


def _candidate_output_dirs(config: Mapping[str, Any]) -> Iterable[Path]:
    seen: set[Path] = set()
    raw_output_dir = str(config.get("output_dir") or DEFAULT_OUTPUT_DIR)
    for output_dir in [Path(raw_output_dir), _robot_artifact_dir(config)]:
        output_dir = output_dir.expanduser()
        if output_dir not in seen:
            seen.add(output_dir)
            yield output_dir


def _robot_artifact_dir(config: Mapping[str, Any]) -> Path:
    robot_path = Path(str(config.get("robot_path") or DEFAULT_ROBOT_PATH))
    if not robot_path.is_absolute():
        robot_path = REPO_ROOT / robot_path
    return robot_path.parent / "output"


def _load_config(config_dir: Path, *, required: bool = True) -> JSONDict:
    config_path = config_dir / DEFAULT_CONFIG_FILE
    if not config_path.is_file():
        if required:
            raise SystemExit(f"missing config; run: fizzy-symphony setup --config-dir {config_dir}")
        return {}
    return _read_json(config_path)


def _read_json(path: Path) -> JSONDict:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return dict(value) if isinstance(value, Mapping) else {}


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.write_text(json.dumps(dict(value), indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _process_status(run_state: Mapping[str, Any]) -> JSONDict:
    pid = _int_or_none(run_state.get("pid"))
    if pid is None:
        return {"state": "not_started", "pid": None}
    return {"state": "running" if _pid_alive(pid) else "stopped", "pid": pid}


def _effective_status(status: Mapping[str, Any], process: Mapping[str, Any]) -> str:
    raw_status = str(status.get("status") or status.get("health") or "unknown")
    if raw_status == "RUNNING" and process.get("state") == "stopped":
        return "STALE/RUNNING"
    return raw_status


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _queue_summary(db_path: Path) -> List[JSONDict]:
    if not db_path.is_file():
        return []
    try:
        with sqlite3.connect(str(db_path)) as connection:
            rows = connection.execute(
                "select queue_name, state, count(*) from work_items group by queue_name, state order by queue_name, state"
            ).fetchall()
    except sqlite3.Error:
        return []
    return [
        {"queue_name": str(queue), "state": str(state), "count": int(count)}
        for queue, state, count in rows
    ]


def _queue_state_label(item: Mapping[str, Any]) -> str:
    queue_name = str(item.get("queue_name") or "")
    state = str(item.get("state") or "")
    if queue_name == DEFAULT_RESULT_QUEUE_NAME and state == "PENDING":
        return "ARTIFACT"
    return state


def _configured_board_ids(config_dir: Path) -> List[str]:
    env = _read_json(config_dir / DEFAULT_ENV_FILE)
    board_id = str(env.get("FIZZY_SYMPHONY_BOARD_ID") or "").strip()
    return [board_id] if board_id else []


def _int_or_none(value: object) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
