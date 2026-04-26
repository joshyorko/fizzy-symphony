from pathlib import Path

import pytest

from fizzy_symphony.board_contracts import NormalizedCard
from fizzy_symphony.workspaces import resolve_card_workspace


def test_workspace_path_is_deterministic_from_stable_card_fields(tmp_path):
    card = NormalizedCard(id="card_abc", number=42, title="Add prompt builder")

    first = resolve_card_workspace(tmp_path, card)
    second = resolve_card_workspace(str(tmp_path), {"id": "card_abc", "number": 42, "title": "Add prompt builder"})

    assert first == second
    assert first == tmp_path / "card-42-card-abc-add-prompt-builder"
    assert not first.exists()


def test_workspace_can_create_directory_on_request(tmp_path):
    path = resolve_card_workspace(tmp_path, {"number": 9, "title": "Workspace setup"}, create=True)

    assert path == tmp_path / "card-9-workspace-setup"
    assert path.is_dir()


def test_workspace_sanitizes_title_and_contains_traversal(tmp_path):
    path = resolve_card_workspace(tmp_path, {"id": "../escape", "number": 12, "title": "../../x"})

    assert path == tmp_path / "card-12-escape-x"
    assert path.is_relative_to(tmp_path)
    assert ".." not in path.relative_to(tmp_path).parts


def test_workspace_rejects_empty_root():
    with pytest.raises(ValueError, match="workspace root"):
        resolve_card_workspace("", {"id": "card-1", "title": "Title"})


def test_workspace_uses_title_when_identifier_and_number_are_missing(tmp_path):
    path = resolve_card_workspace(tmp_path, {"title": "Review: prompt + workspace!"})

    assert path == tmp_path / "card-review-prompt-workspace"


def test_workspace_slug_is_length_bounded_and_recognizable_for_long_titles(tmp_path):
    long_title = " ".join(["Prompt spoofing guardrails and workspace containment"] * 12)
    card = {"id": "card_abc_def", "number": 12345, "title": long_title}

    first = resolve_card_workspace(tmp_path, card)
    second = resolve_card_workspace(tmp_path, dict(card))
    slug = first.name

    assert first == second
    assert len(slug) <= 120
    assert slug.startswith("card-12345-card-abc-def-")
    assert slug != "card-12345-card-abc-def"
    assert Path(slug).name == slug
