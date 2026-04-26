"""Deterministic per-card workspace resolution."""

from __future__ import annotations

import re
from hashlib import sha256
from pathlib import Path
from typing import Any, Mapping, Union


__all__ = ["resolve_card_workspace"]

_SEGMENT_PATTERN = re.compile(r"[^a-zA-Z0-9-]+")
_MAX_SLUG_LENGTH = 120
_MAX_NUMBER_LENGTH = 24
_MAX_IDENTIFIER_LENGTH = 48
_HASH_LENGTH = 12


def resolve_card_workspace(workspace_root: Union[str, Path], card: object, *, create: bool = False) -> Path:
    """Resolve a deterministic child workspace path for a board card."""

    if str(workspace_root).strip() == "":
        raise ValueError("workspace root must not be empty.")

    root = Path(workspace_root).expanduser().resolve(strict=False)
    slug = _card_slug(card)
    path = (root / slug).resolve(strict=False)
    if not path.is_relative_to(root):
        raise ValueError("resolved workspace path escaped workspace root.")

    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path


def _card_slug(card: object) -> str:
    number = _sanitize(_get(card, "number", "card_number", default=""))
    identifier = _sanitize(_get(card, "id", "card_id", default=""))
    title = _sanitize(_get(card, "title", "card_title", "name", default=""))

    parts = ["card"]
    if number and number != "0":
        parts.append(number)
    if identifier:
        parts.append(identifier)
    if title:
        parts.append(title)

    slug = "-".join(parts)
    return _bounded_slug(slug, number=number, identifier=identifier, title=title) if slug != "card" else "card-unknown"


def _bounded_slug(slug: str, *, number: str, identifier: str, title: str) -> str:
    if len(slug) <= _MAX_SLUG_LENGTH:
        return slug

    digest = sha256(slug.encode("utf-8")).hexdigest()[:_HASH_LENGTH]
    fixed_parts = ["card"]
    if number and number != "0":
        fixed_parts.append(_truncate_segment(number, _MAX_NUMBER_LENGTH))
    if identifier:
        fixed_parts.append(_truncate_segment(identifier, _MAX_IDENTIFIER_LENGTH))

    prefix = "-".join(part for part in fixed_parts if part)
    suffix = f"-{digest}"
    title_budget = _MAX_SLUG_LENGTH - len(prefix) - len(suffix) - 1
    if title_budget > 0:
        trimmed_title = _truncate_segment(title, title_budget)
        if trimmed_title:
            return f"{prefix}-{trimmed_title}{suffix}"
    return f"{prefix[: _MAX_SLUG_LENGTH - len(suffix)]}{suffix}".strip("-")


def _truncate_segment(segment: str, max_length: int) -> str:
    if len(segment) <= max_length:
        return segment
    return segment[:max_length].strip("-")


def _sanitize(value: object) -> str:
    text = str(value or "").strip().lower()
    text = text.replace("/", "-").replace("\\", "-")
    text = _SEGMENT_PATTERN.sub("-", text)
    text = re.sub(r"-+", "-", text).strip(".-_")
    return text


def _get(obj: object, *names: str, default: object = None) -> object:
    if isinstance(obj, Mapping):
        for name in names:
            if name in obj and obj[name] not in (None, ""):
                return obj[name]
        return default

    for name in names:
        if hasattr(obj, name):
            return getattr(obj, name)
    return default
