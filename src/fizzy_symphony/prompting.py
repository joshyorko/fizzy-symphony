"""Board-native prompt construction for Fizzy Symphony workers."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any, List


__all__ = ["build_board_prompt"]


def build_board_prompt(
    *,
    service_context: object,
    golden_ticket: object,
    work_card: object,
    comments: Sequence[object] = (),
) -> str:
    """Build the worker prompt from board-native card context."""

    sections = [
        ("Service Context", _service_context_text(service_context)),
        ("Golden-Ticket Prompt", _golden_ticket_text(golden_ticket)),
        ("Golden-Ticket Steps", _steps_text(_get(golden_ticket, "steps", default=[]))),
        ("Work Card", _work_card_text(work_card)),
        ("Comments / Discussion", _comments_text(comments)),
        ("Proof Instructions", _proof_text()),
    ]
    return "\n\n".join(f"## {heading}\n{body}" for heading, body in sections)


def _service_context_text(service_context: object) -> str:
    if isinstance(service_context, Mapping):
        summary = _first_present(service_context, ("summary", "context", "description", "body", "text"))
        return str(summary).strip() if summary else "No service context provided."
    text = str(service_context or "").strip()
    return text or "No service context provided."


def _golden_ticket_text(golden_ticket: object) -> str:
    title = _text(_get(golden_ticket, "card_title", "title", "name", default=""))
    description = _text(_get(golden_ticket, "card_description", "description", "body", default=""))
    tags = _normalize_words(_get(golden_ticket, "card_tags", "tags", default=[]))

    lines = [
        *_labeled_text_block("Title", title or "Untitled golden ticket"),
        *_labeled_text_block("Description", description or "none"),
        f"Tags: {_comma_list(tags)}",
    ]
    return "\n".join(lines)


def _work_card_text(work_card: object) -> str:
    number = _inline_text(_get(work_card, "number", "card_number", default=""))
    title = _text(_get(work_card, "title", "card_title", "name", default=""))
    description = _text(_get(work_card, "description", "card_description", "body", default=""))
    tags = _normalize_words(_get(work_card, "tags", "card_tags", default=[]))
    assignees = _normalize_words(_get(work_card, "assignees", "assigned_to", "owners", default=[]))
    steps = _normalize_steps(_get(work_card, "steps", default=[]))

    lines = [
        f"Number: {number or 'none'}",
        *_labeled_text_block("Title", title or "Untitled work card"),
        *_labeled_text_block("Description", description or "none"),
        f"Tags: {_comma_list(tags)}",
        f"Assignees: {_comma_list(assignees)}",
        "Steps:",
        *_bullet_lines(steps),
    ]
    return "\n".join(lines)


def _steps_text(raw_steps: object) -> str:
    steps = _normalize_steps(raw_steps)
    return "\n".join(_bullet_lines(steps))


def _comments_text(comments: Sequence[object]) -> str:
    lines: List[str] = []
    for comment in comments:
        body = _text(_get(comment, "body", "content", "text", default=""))
        if not body:
            continue
        author = _author_name(_get(comment, "author", "user", default=""))
        created_at = _inline_text(_get(comment, "created_at", "createdAt", default=""))
        prefix = " ".join(part for part in (created_at, author) if part)
        lines.extend(_comment_lines(prefix, body))
    return "\n".join(lines) if lines else "No comments yet."


def _proof_text() -> str:
    return "\n".join(
        [
            "Leave concise proof with:",
            "- files changed",
            "- validation run",
            "- blockers",
        ]
    )


def _bullet_lines(values: Sequence[str]) -> List[str]:
    if not values:
        return ["No steps provided."]
    lines: List[str] = []
    for value in values:
        block = _indented_text_block(value)
        if len(block) == 1:
            lines.append(f"- {block[0].lstrip()}")
        else:
            lines.append("-")
            lines.extend(block)
    return lines


def _labeled_text_block(label: str, value: str) -> List[str]:
    return [f"{label}:", *_indented_text_block(value)]


def _comment_lines(prefix: str, body: str) -> List[str]:
    header = f"- {prefix}:" if prefix else "-"
    return [header, *_indented_text_block(body)]


def _indented_text_block(value: str) -> List[str]:
    lines = str(value).splitlines() or [""]
    return [f"    {line}" if line else "    " for line in lines]


def _normalize_steps(raw_steps: object) -> List[str]:
    if not isinstance(raw_steps, Iterable) or isinstance(raw_steps, (str, bytes, Mapping)):
        return []

    steps: List[str] = []
    for raw_step in raw_steps:
        value = _text(_known_mapping_value(raw_step, ("content", "title", "name")) or raw_step)
        if value:
            steps.append(value)
    return steps


def _normalize_words(raw_values: object) -> List[str]:
    if not isinstance(raw_values, Iterable) or isinstance(raw_values, (str, bytes, Mapping)):
        single = _inline_text(
            _known_mapping_value(raw_values, ("name", "title", "label", "login", "username")) or raw_values
        )
        return [single] if single else []

    values: List[str] = []
    for raw_value in raw_values:
        value = _inline_text(
            _known_mapping_value(raw_value, ("name", "title", "label", "login", "username")) or raw_value
        )
        if value:
            values.append(value.strip().lstrip("#").strip())
    return values


def _comma_list(values: Sequence[str]) -> str:
    return ", ".join(values) if values else "none"


def _author_name(raw_author: object) -> str:
    return _inline_text(_known_mapping_value(raw_author, ("name", "username", "login")) or raw_author)


def _get(obj: object, *names: str, default: object = None) -> object:
    if isinstance(obj, Mapping):
        value = _first_present(obj, names)
        return default if value is None else value

    for name in names:
        if hasattr(obj, name):
            return getattr(obj, name)
    return default


def _first_present(mapping: Mapping[str, Any], names: Sequence[str]) -> object:
    for name in names:
        if name in mapping and mapping[name] not in (None, ""):
            return mapping[name]
    return None


def _known_mapping_value(value: object, names: Sequence[str]) -> object:
    if not isinstance(value, Mapping):
        return None
    return _first_present(value, names)


def _text(value: object) -> str:
    return str(value or "").strip()


def _inline_text(value: object) -> str:
    return " ".join(_text(value).split())
