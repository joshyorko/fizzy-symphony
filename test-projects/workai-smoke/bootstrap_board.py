"""Print or run Fizzy CLI commands for the WorkAI smoke fixture."""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
from pathlib import Path
from typing import Iterable, List, Mapping, Optional


FIXTURE_PATH = Path(__file__).with_name("board.fixture.json")
BOARD_ID_PLACEHOLDER = "${WORKAI_SMOKE_BOARD_ID}"
BOARD_EXPORT_PLACEHOLDER = "<board id from fizzy board create>"


def shell_join(parts: Iterable[str]) -> str:
    """Return a zsh-friendly command string."""
    return " ".join(_shell_part(part) for part in parts)


def _shell_part(part: str) -> str:
    if part.startswith("${") and part.endswith("}"):
        return part
    return shlex.quote(part)


def load_fixture(path: Path = FIXTURE_PATH) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def card_description(card: dict, *, golden: bool = False) -> str:
    prefix = "[golden-ticket] " if golden else ""
    return f"{prefix}{card['description']}"


def card_placeholder(prefix: str, index: int) -> str:
    return f"<{prefix}_{index}_NUMBER>"


def build_dry_run_commands(fixture: dict, *, board_id: str = BOARD_ID_PLACEHOLDER) -> List[str]:
    board = fixture["board"]
    commands = [
        shell_join(["fizzy", "doctor"]),
        shell_join(["fizzy", "board", "create", "--name", board["name"], "--agent", "--quiet"]),
        f"export WORKAI_SMOKE_BOARD_ID={shlex.quote(BOARD_EXPORT_PLACEHOLDER)}",
        shell_join(["fizzy", "column", "list", "--board", board_id, "--agent", "--quiet"]),
    ]

    for column in board["recommended_columns"]:
        commands.append(
            shell_join(
                [
                    "fizzy",
                    "column",
                    "create",
                    "--board",
                    board_id,
                    "--name",
                    column,
                    "--agent",
                    "--quiet",
                ]
            )
        )

    commands.extend(
        _card_dry_run_commands(
            fixture.get("golden_tickets", []),
            board_id=board_id,
            placeholder_prefix="GOLDEN",
            golden=True,
        )
    )
    commands.extend(
        _card_dry_run_commands(
            fixture.get("task_cards", []),
            board_id=board_id,
            placeholder_prefix="TASK",
            golden=False,
        )
    )

    return commands


def _card_dry_run_commands(
    cards: List[dict],
    *,
    board_id: str,
    placeholder_prefix: str,
    golden: bool,
) -> List[str]:
    commands: List[str] = []
    for index, card in enumerate(cards, start=1):
        placeholder = card_placeholder(placeholder_prefix, index)
        commands.append(
            shell_join(
                [
                    "fizzy",
                    "card",
                    "create",
                    "--board",
                    board_id,
                    "--title",
                    card["title"],
                    "--description",
                    card_description(card, golden=golden),
                    "--agent",
                    "--quiet",
                ]
            )
        )
        for tag in card.get("tags", []):
            commands.append(shell_join(["fizzy", "card", "tag", placeholder, "--tag", tag]))
        if card.get("golden"):
            commands.append(shell_join(["fizzy", "card", "golden", placeholder]))
        if card.get("target_column"):
            commands.append(
                shell_join(
                    [
                        "fizzy",
                        "card",
                        "column",
                        placeholder,
                        "--column",
                        f"<{card['target_column']} column id>",
                    ]
                )
            )
    return commands


def executable_commands(fixture: dict, *, board_id: str) -> List[List[str]]:
    commands = []
    for command in build_dry_run_commands(fixture, board_id=board_id):
        if command.startswith("export "):
            continue
        if "board create" in command:
            continue
        if "<" in command:
            continue
        commands.append(shlex.split(command))
    return commands


def run_json(command: List[str]) -> Mapping[str, object]:
    completed = subprocess.run(command, check=True, capture_output=True, text=True)
    output = completed.stdout.strip()
    if not output:
        return {}
    data = json.loads(output)
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        return data["data"]
    if isinstance(data, dict):
        return data
    return {}


def resource_id(resource: Mapping[str, object]) -> Optional[str]:
    value = resource.get("id")
    return str(value) if value else None


def create_board(fixture: dict) -> str:
    board = fixture["board"]
    created = run_json(
        [
            "fizzy",
            "board",
            "create",
            "--name",
            board["name"],
            "--agent",
            "--quiet",
        ]
    )
    board_id = resource_id(created)
    if not board_id:
        raise RuntimeError("fizzy board create did not return an id")
    return board_id


def card_number(resource: Mapping[str, object]) -> Optional[str]:
    value = resource.get("number")
    return str(value) if value else None


def configure_live_board(fixture: dict, *, board_id: str) -> dict:
    subprocess.run(["fizzy", "doctor"], check=True)
    subprocess.run(
        ["fizzy", "column", "list", "--board", board_id, "--agent", "--quiet"],
        check=True,
    )

    column_ids: dict[str, str] = {}
    for column in fixture["board"]["recommended_columns"]:
        created = run_json(
            [
                "fizzy",
                "column",
                "create",
                "--board",
                board_id,
                "--name",
                column,
                "--agent",
                "--quiet",
            ]
        )
        created_id = resource_id(created)
        if created_id:
            column_ids[column] = created_id

    golden_tickets = []
    for card in fixture.get("golden_tickets", []):
        golden_tickets.append(
            create_and_configure_card(card, board_id=board_id, column_ids=column_ids, golden=True)
        )

    task_cards = []
    for card in fixture.get("task_cards", []):
        task_cards.append(
            create_and_configure_card(
                card,
                board_id=board_id,
                column_ids=column_ids,
                golden=False,
            )
        )

    golden_number = next(
        (card.get("number") for card in golden_tickets if card.get("golden")),
        None,
    )
    card_number_env = ",".join(
        f"{index}={card['number']}"
        for index, card in enumerate(task_cards, start=1)
        if card.get("number")
    )
    handoff_column_id = column_ids.get("Synthesize & Verify")
    return {
        "board_id": board_id,
        "cleanup_command": shell_join(["fizzy", "board", "delete", board_id]),
        "columns": column_ids,
        "golden_tickets": golden_tickets,
        "task_cards": task_cards,
        "smoke_env": {
            "WORKAI_SMOKE_BOARD_ID": board_id,
            "WORKAI_SMOKE_CARD_NUMBERS": card_number_env,
            "WORKAI_SMOKE_GOLDEN_CARD_NUMBER": golden_number,
            "WORKAI_SMOKE_HANDOFF_COLUMN_ID": handoff_column_id,
            "WORKAI_SMOKE_LIVE_FIZZY": "1",
        },
    }


def create_and_configure_card(
    card: dict,
    *,
    board_id: str,
    column_ids: Mapping[str, str],
    golden: bool,
) -> dict:
    created = run_json(
        [
            "fizzy",
            "card",
            "create",
            "--board",
            board_id,
            "--title",
            card["title"],
            "--description",
            card_description(card, golden=golden),
            "--agent",
            "--quiet",
        ]
    )
    number = card_number(created)
    summary = {
        "title": card["title"],
        "number": number,
        "golden": bool(card.get("golden")),
        "target_column": card.get("target_column"),
        "tags": list(card.get("tags", [])),
        "marked_golden": False,
    }
    if not number:
        return summary

    for tag in card.get("tags", []):
        subprocess.run(["fizzy", "card", "tag", number, "--tag", tag], check=True)

    if card.get("golden"):
        subprocess.run(["fizzy", "card", "golden", number], check=True)
        summary["marked_golden"] = True

    target_column = card.get("target_column")
    column_id = column_ids.get(str(target_column)) if target_column else None
    if column_id:
        subprocess.run(["fizzy", "card", "column", number, "--column", column_id], check=True)
    return summary


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=FIXTURE_PATH)
    parser.add_argument("--board-id", help="Disposable Fizzy board id to configure.")
    parser.add_argument(
        "--create-board",
        action="store_true",
        help="With --live, create the disposable board before configuring it.",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Run Fizzy commands instead of printing them.",
    )
    args = parser.parse_args(argv)

    fixture = load_fixture(args.fixture)
    board_id = args.board_id or BOARD_ID_PLACEHOLDER
    commands = build_dry_run_commands(fixture, board_id=board_id)

    if not args.live:
        print("# Dry run only. No Fizzy commands were executed.")
        print("# Create a disposable board, export its id, then run the setup commands:")
        for command in commands:
            print(command)
        print("# When the smoke is complete, delete only the disposable board:")
        print(shell_join(["fizzy", "board", "delete", board_id]))
        return 0

    if not args.board_id and not args.create_board:
        parser.error("--live requires --board-id or --create-board")

    live_board_id = args.board_id or create_board(fixture)
    summary = configure_live_board(fixture, board_id=live_board_id)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
