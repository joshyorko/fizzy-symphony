"""Board-native contracts for Fizzy Symphony routing and reporting."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple


AGENT_INSTRUCTIONS_TAG = "agent-instructions"
BACKEND_TAGS = ("codex", "claude", "opencode", "anthropic", "openai", "command")
DEFAULT_BACKEND = "codex"

__all__ = [
    "AGENT_INSTRUCTIONS_TAG",
    "BACKEND_TAGS",
    "DEFAULT_BACKEND",
    "ActiveRunSummary",
    "CompletionAction",
    "CompletionPolicy",
    "DuplicateGoldenTicketError",
    "GoldenTicketRouteError",
    "GoldenTicketRoute",
    "NormalizedCard",
    "NormalizedComment",
    "ReporterResult",
    "build_routes_by_column",
    "normalize_card",
    "normalize_comment",
    "normalize_steps",
    "normalize_tags",
    "parse_golden_ticket_route",
]


class CompletionAction(str, Enum):
    """Actions the reporter may take after a worker completes a card."""

    COMMENT = "comment"
    CLOSE = "close"
    MOVE = "move"


@dataclass(frozen=True)
class CompletionPolicy:
    """Completion behavior parsed from a golden ticket tag."""

    action: CompletionAction = CompletionAction.COMMENT
    target_column_id: Optional[str] = None
    target_column_name: Optional[str] = None

    def __post_init__(self) -> None:
        if self.action == CompletionAction.MOVE:
            if not self.target_column_id:
                raise ValueError("CompletionPolicy.target_column_id is required for move.")
            if not self.target_column_name:
                raise ValueError("CompletionPolicy.target_column_name is required for move.")
        elif self.target_column_id or self.target_column_name:
            raise ValueError("CompletionPolicy move target is only valid for move actions.")


@dataclass(frozen=True)
class NormalizedComment:
    """Small, stable comment shape normalized from Fizzy CLI/API JSON."""

    id: str
    body: str
    author: str = ""
    created_at: str = ""
    raw: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NormalizedCard:
    """Small, stable card shape normalized from Fizzy CLI/API JSON."""

    id: str
    number: int
    title: str
    description: str = ""
    tags: Tuple[str, ...] = field(default_factory=tuple)
    steps: Tuple[str, ...] = field(default_factory=tuple)
    column_id: str = ""
    column_name: str = ""
    golden: bool = False
    raw: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class GoldenTicketRoute:
    """Route context extracted from a board-native golden ticket card."""

    board_id: str
    column_id: str
    column_name: str
    card_number: int
    card_title: str
    card_description: str
    card_tags: Tuple[str, ...]
    steps: Tuple[str, ...]
    backend: str
    completion_policy: CompletionPolicy = field(default_factory=CompletionPolicy)


@dataclass(frozen=True)
class ActiveRunSummary:
    """Lightweight status payload for active worker runs."""

    card_number: int
    backend: str
    status: str
    summary: str = ""
    route_column_id: str = ""


@dataclass(frozen=True)
class ReporterResult:
    """Lightweight result payload for reporter integrations."""

    card_number: int
    success: bool
    message: str = ""
    completion_policy: CompletionPolicy = field(default_factory=CompletionPolicy)


class DuplicateGoldenTicketError(ValueError):
    """Raised when more than one golden ticket configures the same column."""


class GoldenTicketRouteError(ValueError):
    """Raised when a golden ticket cannot produce a usable route."""


def normalize_tags(raw_tags: object) -> List[str]:
    """Normalize Fizzy tags from strings or common object shapes."""

    if not isinstance(raw_tags, Iterable) or isinstance(raw_tags, (str, bytes, Mapping)):
        return []

    tags: List[str] = []
    for raw_tag in raw_tags:
        value = _string_from_known_keys(raw_tag, ("name", "title", "label"))
        tag = value.strip().lstrip("#").strip().lower()
        if tag:
            tags.append(tag)
    return tags


def normalize_steps(raw_steps: object) -> List[str]:
    """Normalize steps from strings or dicts with content/title/name fields."""

    if not isinstance(raw_steps, Iterable) or isinstance(raw_steps, (str, bytes, Mapping)):
        return []

    steps: List[str] = []
    for raw_step in raw_steps:
        step = _string_from_known_keys(raw_step, ("content", "title", "name")).strip()
        if step:
            steps.append(step)
    return steps


def normalize_card(raw_card: Mapping[str, Any]) -> NormalizedCard:
    """Normalize a Fizzy CLI/API card mapping into the shared card contract."""

    column = raw_card.get("column")
    column_id = ""
    column_name = ""
    if isinstance(column, Mapping):
        column_id = str(column.get("id") or "")
        column_name = str(column.get("name") or column.get("title") or "")

    return NormalizedCard(
        id=str(raw_card.get("id") or ""),
        number=int(raw_card.get("number") or 0),
        title=str(raw_card.get("title") or raw_card.get("name") or ""),
        description=str(raw_card.get("description") or raw_card.get("body") or ""),
        tags=tuple(normalize_tags(raw_card.get("tags", []))),
        steps=tuple(normalize_steps(raw_card.get("steps", []))),
        column_id=column_id,
        column_name=column_name,
        golden=raw_card.get("golden") is True,
        raw=raw_card,
    )


def normalize_comment(raw_comment: Mapping[str, Any]) -> NormalizedComment:
    """Normalize a Fizzy CLI/API comment mapping into the shared comment contract."""

    author = raw_comment.get("author") or raw_comment.get("user") or ""
    if isinstance(author, Mapping):
        author_name = str(author.get("name") or author.get("username") or author.get("login") or "")
    else:
        author_name = str(author)

    return NormalizedComment(
        id=str(raw_comment.get("id") or ""),
        body=str(raw_comment.get("body") or raw_comment.get("content") or raw_comment.get("text") or ""),
        author=author_name,
        created_at=str(raw_comment.get("created_at") or raw_comment.get("createdAt") or ""),
        raw=raw_comment,
    )


def parse_golden_ticket_route(
    raw_card: Mapping[str, Any],
    *,
    board_id: str,
    columns: Sequence[Mapping[str, Any]],
    default_backend: str = DEFAULT_BACKEND,
) -> Optional[GoldenTicketRoute]:
    """Parse a golden ticket route from a Fizzy card, returning ``None`` for ordinary cards."""

    card = normalize_card(raw_card)
    if not card.golden or AGENT_INSTRUCTIONS_TAG not in card.tags:
        return None
    if not card.column_id:
        raise GoldenTicketRouteError(f"Golden ticket card {card.number} missing column id.")
    if not card.column_name:
        raise GoldenTicketRouteError(f"Golden ticket card {card.number} missing column name.")

    backend = _resolve_backend(card.tags, default_backend=default_backend)
    completion_policy = _resolve_completion_policy(card.tags, columns)
    return GoldenTicketRoute(
        board_id=board_id,
        column_id=card.column_id,
        column_name=card.column_name,
        card_number=card.number,
        card_title=card.title,
        card_description=card.description,
        card_tags=card.tags,
        steps=card.steps,
        backend=backend,
        completion_policy=completion_policy,
    )


def build_routes_by_column(
    cards: Sequence[Mapping[str, Any]],
    *,
    board_id: str,
    columns: Sequence[Mapping[str, Any]],
    default_backend: str = DEFAULT_BACKEND,
) -> Dict[str, GoldenTicketRoute]:
    """Build a ``column_id -> route`` mapping from golden ticket cards."""

    routes: Dict[str, GoldenTicketRoute] = {}
    for raw_card in cards:
        route = parse_golden_ticket_route(
            raw_card,
            board_id=board_id,
            columns=columns,
            default_backend=default_backend,
        )
        if route is None:
            continue
        if route.column_id in routes:
            existing = routes[route.column_id]
            raise DuplicateGoldenTicketError(
                "Duplicate golden tickets for column "
                f"{route.column_id}: cards {existing.card_number} and {route.card_number}."
            )
        routes[route.column_id] = route
    return routes


def _resolve_backend(tags: Sequence[str], *, default_backend: str) -> str:
    for tag in tags:
        if tag in BACKEND_TAGS:
            return tag
    return default_backend or DEFAULT_BACKEND


def _resolve_completion_policy(
    tags: Sequence[str],
    columns: Sequence[Mapping[str, Any]],
) -> CompletionPolicy:
    for tag in tags:
        if tag == "close-on-complete":
            return CompletionPolicy(action=CompletionAction.CLOSE)
        if tag.startswith("move-to-"):
            target_name = tag[len("move-to-") :].replace("-", " ").strip()
            target = _find_column(target_name, columns)
            if target is None:
                raise ValueError(f"Move completion column not found: {target_name}.")
            return CompletionPolicy(
                action=CompletionAction.MOVE,
                target_column_id=str(target.get("id") or ""),
                target_column_name=str(target.get("name") or target.get("title") or ""),
            )
    return CompletionPolicy(action=CompletionAction.COMMENT)


def _find_column(
    column_name: str,
    columns: Sequence[Mapping[str, Any]],
) -> Optional[Mapping[str, Any]]:
    wanted_slug = _slugify(column_name)
    wanted_name = column_name.strip().lower()
    for column in columns:
        raw_name = str(column.get("name") or column.get("title") or "")
        if raw_name.strip().lower() == wanted_name or _slugify(raw_name) == wanted_slug:
            return column
    return None


def _slugify(value: str) -> str:
    normalized = re.sub(r"\band\b", " ", value.lower())
    words = re.findall(r"[a-z0-9]+", normalized)
    return "-".join(words)


def _string_from_known_keys(value: object, keys: Sequence[str]) -> str:
    if isinstance(value, Mapping):
        for key in keys:
            if key in value and value[key] is not None:
                return str(value[key])
        return ""
    return str(value)
