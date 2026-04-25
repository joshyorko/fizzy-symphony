import pytest

from fizzy_symphony.models import FizzyCard
from fizzy_symphony.workitem_queue import (
    FizzyWorkItemPayload,
    WorkItemQueue,
    WorkItemState,
)


class FakeAdapter:
    def __init__(self):
        self.items = {}
        self.outputs = []
        self.releases = []
        self.next_id = 1

    def seed_input(self, payload=None, parent_id="", files=None):  # noqa: ARG002
        item_id = f"item-{self.next_id}"
        self.next_id += 1
        self.items[item_id] = payload or {}
        return item_id

    def reserve_input(self):
        return next(iter(self.items))

    def load_payload(self, item_id):
        return self.items[item_id]

    def release_input(self, item_id, state, exception=None):
        self.releases.append((item_id, state, exception))

    def create_output(self, parent_id, payload=None):
        output_id = f"output-{len(self.outputs) + 1}"
        self.outputs.append((output_id, parent_id, payload or {}))
        return output_id

    def save_payload(self, item_id, payload):
        self.items[item_id] = payload

    def list_files(self, item_id):  # noqa: ARG002
        return []

    def get_file(self, item_id, name):  # noqa: ARG002
        return b""

    def add_file(self, item_id, name, content):  # noqa: ARG002
        return None

    def remove_file(self, item_id, name):  # noqa: ARG002
        return None


def _card() -> FizzyCard:
    return FizzyCard(
        id="03abc",
        number=579,
        identifier="579",
        title="Fix login",
        description="Broken auth",
        state="Ready for Agents",
        url="https://fizzy.test/cards/579",
        labels=["bug"],
        branch_name="fizzy/579-fix-login",
        column_id="ready-for-agents",
    )


def test_payload_round_trips_fizzy_card_context():
    payload = FizzyWorkItemPayload.from_card(
        _card(),
        board_id="board-1",
        prompt_template="Work {{ issue.title }}",
        allowed_paths=["src/", "tests/"],
        handoff_column="synthesize-and-verify",
        runner_command="codex exec --json",
    )

    data = payload.to_dict()
    restored = FizzyWorkItemPayload.from_dict(data)

    assert data["source"] == "fizzy"
    assert data["card"]["number"] == 579
    assert restored.card["title"] == "Fix login"
    assert restored.workflow["allowed_paths"] == ["src/", "tests/"]
    assert restored.runner["command"] == "codex exec --json"


def test_queue_can_seed_reserve_complete_and_emit_output():
    adapter = FakeAdapter()
    queue = WorkItemQueue(adapter)
    payload = FizzyWorkItemPayload.from_card(_card(), board_id="board-1")

    item_id = queue.enqueue_input(payload)
    reserved = queue.reserve()
    output_id = queue.complete(reserved.id, {"status": "ok", "card_number": 579})

    assert item_id == "item-1"
    assert reserved.id == "item-1"
    assert reserved.payload["card"]["number"] == 579
    assert output_id == "output-1"
    assert adapter.outputs == [("output-1", "item-1", {"status": "ok", "card_number": 579})]
    assert adapter.releases == [("item-1", WorkItemState.DONE, None)]


def test_queue_failure_uses_application_exception_payload():
    adapter = FakeAdapter()
    queue = WorkItemQueue(adapter)
    item_id = queue.enqueue_input(FizzyWorkItemPayload.from_card(_card(), board_id="board-1"))

    queue.fail(item_id, message="codex failed", code="CODEX_FAILED")

    assert adapter.releases == [
        (
            "item-1",
            WorkItemState.FAILED,
            {"type": "APPLICATION", "code": "CODEX_FAILED", "message": "codex failed"},
        )
    ]


def test_enqueue_requires_seed_input_support():
    class MinimalAdapter(FakeAdapter):
        seed_input = None

    queue = WorkItemQueue(MinimalAdapter())

    with pytest.raises(RuntimeError, match="seed_input"):
        queue.enqueue_input(FizzyWorkItemPayload.from_card(_card(), board_id="board-1"))
