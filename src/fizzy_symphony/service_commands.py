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


JSONDict = Dict[str, Any]

DEFAULT_CONFIG_DIR = ".fizzy-symphony"
DEFAULT_CONFIG_FILE = "config.json"
DEFAULT_ENV_FILE = "env.json"
DEFAULT_RUN_FILE = "run.json"
DEFAULT_LOG_FILE = "service.log"
DEFAULT_ROBOT_PATH = "robots/workitems/robot.yaml"
DEFAULT_OUTPUT_DIR = "robots/workitems/output"
DEFAULT_TASK = "FizzySymphony"


def setup_command(args: object) -> int:
    """Create local service config and env files."""

    config_dir = _config_dir(args)
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / DEFAULT_CONFIG_FILE
    env_path = config_dir / DEFAULT_ENV_FILE

    config = {
        "created_at": _now_iso(),
        "rcc_bin": str(getattr(args, "rcc_bin", "rcc") or "rcc"),
        "robot_path": str(getattr(args, "robot_path", DEFAULT_ROBOT_PATH) or DEFAULT_ROBOT_PATH),
        "task": DEFAULT_TASK,
        "output_dir": str(getattr(args, "output_dir", DEFAULT_OUTPUT_DIR) or DEFAULT_OUTPUT_DIR),
    }
    env = _build_env(args)

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
    """Start the RCC-backed service in foreground or detached mode."""

    config_dir = _config_dir(args)
    config = _load_config(config_dir)
    env_path = config_dir / DEFAULT_ENV_FILE
    if not env_path.is_file():
        print(f"error: missing env file: {env_path}", file=sys.stderr)
        return 2

    command = _rcc_command(config, env_path, silent=not bool(getattr(args, "verbose", False)))
    if bool(getattr(args, "dry_run", False)):
        print(" ".join(command))
        return 0

    if bool(getattr(args, "detach", False)):
        return _start_detached(config_dir, command)

    print("Starting Fizzy Symphony watcher. Press Ctrl-C to stop.")
    print(" ".join(command))
    return subprocess.run(command, check=False).returncode


def status_command(args: object) -> int:
    """Print process, latest artifact, and queue status."""

    config_dir = _config_dir(args)
    config = _load_config(config_dir, required=False)
    run_state = _read_json(config_dir / DEFAULT_RUN_FILE)
    output_dir = Path(str(config.get("output_dir") or DEFAULT_OUTPUT_DIR))
    status = _read_json(output_dir / "fizzy-symphony-status.json")
    queue = _queue_summary(output_dir / "fizzy-symphony-smoke.db")

    if bool(getattr(args, "json", False)):
        print(
            json.dumps(
                {
                    "process": _process_status(run_state),
                    "run": run_state,
                    "status": status,
                    "queue": queue,
                    "config": config,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0

    process = _process_status(run_state)
    print("Fizzy Symphony Status")
    print(f"process: {process['state']}" + (f" pid={process['pid']}" if process.get("pid") else ""))
    if run_state.get("log_path"):
        print(f"log: {run_state['log_path']}")
    if status:
        print(f"status: {status.get('status') or status.get('health') or 'unknown'}")
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
            print(f"  {item['queue_name']} {item['state']}: {item['count']}")
    return 0


def boards_command(args: object) -> int:
    """List Fizzy boards, then configured board columns when available."""

    fizzy_bin = str(getattr(args, "fizzy_bin", "fizzy") or "fizzy")
    command = [fizzy_bin, "board", "list", "--markdown"]
    completed = subprocess.run(command, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        print(completed.stderr or completed.stdout or "fizzy board list failed", file=sys.stderr)
        return completed.returncode
    print(completed.stdout, end="")

    board_ids = _configured_board_ids(_config_dir(args))
    for board_id in board_ids:
        column_command = [fizzy_bin, "column", "list", "--board", board_id, "--markdown"]
        columns = subprocess.run(column_command, text=True, capture_output=True, check=False)
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


def _build_env(args: object) -> JSONDict:
    workspace = str(getattr(args, "workspace", "") or "")
    prompt = str(getattr(args, "prompt", "") or "")
    prompt_file = str(getattr(args, "prompt_file", "") or "")
    env = {
        "FIZZY_SYMPHONY_WORKSPACE": workspace,
        "FIZZY_SYMPHONY_PROMPT": prompt,
        "FIZZY_SYMPHONY_PROMPT_FILE": prompt_file,
        "FIZZY_SYMPHONY_BOARD_NAME": str(getattr(args, "board_name", "") or ""),
        "FIZZY_SYMPHONY_CARD_TITLE": str(getattr(args, "card_title", "") or ""),
        "FIZZY_SYMPHONY_RUN_MODE": str(getattr(args, "run_mode", "once") or "once"),
        "FIZZY_SYMPHONY_BOARD_ID": str(getattr(args, "board_id", "") or ""),
        "FIZZY_SYMPHONY_CARD_NUMBER": str(getattr(args, "card_number", "") or ""),
    }
    return {key: value for key, value in env.items() if value != "" or key in {"FIZZY_SYMPHONY_BOARD_ID", "FIZZY_SYMPHONY_CARD_NUMBER"}}


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
    log_file = log_path.open("ab")
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
