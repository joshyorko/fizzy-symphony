from fizzy_symphony.models import FizzyCard
from fizzy_symphony.workitem_pipeline import (
    CodexWorkItemWorker,
    FizzyWorkItemProducer,
    FizzyWorkItemReporter,
)
from fizzy_symphony.workitem_queue import WorkItemQueue, WorkItemState


class FakeAdapter:
    def __init__(self):
        self.items = {}
        self.outputs = {}
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
        self.items.pop(item_id, None)

    def create_output(self, parent_id, payload=None):
        output_id = f"output-{len(self.outputs) + 1}"
        self.outputs[output_id] = payload or {}
        return output_id

    def save_payload(self, item_id, payload):
        self.items[item_id] = payload


class FakeTracker:
    def __init__(self, cards=None):
        self.cards = cards or []
        self.comments = []
        self.columns = []

    def get_card(self, card_number):  # noqa: ARG002
        raise NotImplementedError

    def fetch_candidate_cards(self):
        return self.cards

    def fetch_cards_by_states(self, states):  # noqa: ARG002
        return []

    def fetch_card_states_by_ids(self, card_ids):  # noqa: ARG002
        return {}

    def create_comment(self, card_number, body):
        self.comments.append((card_number, body))

    def move_card_to_column(self, card_number, column_id):
        self.columns.append((card_number, column_id))

    def assign_card(self, card_number, user_id):  # noqa: ARG002
        raise NotImplementedError

    def self_assign_card(self, card_number):  # noqa: ARG002
        raise NotImplementedError

    def claim_card(self, card_number, in_flight_column_id, comment_body, assignee_id=None, self_assign=False):  # noqa: ARG002
        raise NotImplementedError


def _card(number=579):
    return FizzyCard(
        id=f"card-{number}",
        number=number,
        identifier=str(number),
        title=f"Card {number}",
        state="Ready for Agents",
    )


def test_producer_enqueues_candidate_cards_as_workitems():
    adapter = FakeAdapter()
    producer = FizzyWorkItemProducer(
        tracker=FakeTracker([_card(1), _card(2)]),
        queue=WorkItemQueue(adapter),
        board_id="board-1",
        prompt_template="Work {{ card.title }}",
    )

    item_ids = producer.produce()

    assert item_ids == ["item-1", "item-2"]
    assert adapter.items["item-1"]["card"]["number"] == 1
    assert adapter.items["item-1"]["workflow"]["prompt_template"] == "Work {{ card.title }}"


def test_worker_completes_reserved_item_with_runner_result():
    adapter = FakeAdapter()
    producer = FizzyWorkItemProducer(
        tracker=FakeTracker([_card(579)]),
        queue=WorkItemQueue(adapter),
        board_id="board-1",
        prompt_template="Work {{ card.title }}",
    )
    producer.produce()

    def runner(payload):
        return {"success": True, "comment": f"Done {payload.card['number']}"}

    result = CodexWorkItemWorker(queue=WorkItemQueue(adapter), runner=runner).work_one()

    assert result.output_id == "output-1"
    assert adapter.outputs["output-1"]["card_id"] == "card-579"
    assert adapter.outputs["output-1"]["comment"] == "Done 579"
    assert adapter.outputs["output-1"]["handoff_column_id"] == "Synthesize & Verify"
    assert adapter.releases == [("item-1", WorkItemState.DONE, None)]


def test_worker_failure_releases_item_as_application_failure():
    adapter = FakeAdapter()
    FizzyWorkItemProducer(
        tracker=FakeTracker([_card(579)]),
        queue=WorkItemQueue(adapter),
        board_id="board-1",
    ).produce()

    def runner(payload):  # noqa: ARG001
        raise RuntimeError("codex exploded")

    result = CodexWorkItemWorker(queue=WorkItemQueue(adapter), runner=runner).work_one()

    assert result.output_id is None
    assert adapter.releases == [
        (
            "item-1",
            WorkItemState.FAILED,
            {"type": "APPLICATION", "code": "CODEX_WORKER_FAILED", "message": "codex exploded"},
        )
    ]


def test_reporter_posts_comment_and_updates_state_from_result_item():
    adapter = FakeAdapter()
    adapter.seed_input(
        payload={
            "card_id": "card-579",
            "card_number": 579,
            "comment": "Proof attached",
            "handoff_column_id": "Synthesize & Verify",
        }
    )
    tracker = FakeTracker()

    result = FizzyWorkItemReporter(queue=WorkItemQueue(adapter), tracker=tracker).report_one()

    assert result.reported is True
    assert tracker.comments == [(579, "Proof attached")]
    assert tracker.columns == [(579, "Synthesize & Verify")]
    assert adapter.releases == [("item-1", WorkItemState.DONE, None)]


def test_reporter_accepts_legacy_handoff_state_key():
    adapter = FakeAdapter()
    adapter.seed_input(
        payload={
            "card_id": "card-579",
            "card_number": 579,
            "comment": "Proof attached",
            "handoff_state": "Synthesize & Verify",
        }
    )
    tracker = FakeTracker()

    result = FizzyWorkItemReporter(queue=WorkItemQueue(adapter), tracker=tracker).report_one()

    assert result.reported is True
    assert tracker.columns == [(579, "Synthesize & Verify")]


def test_reporter_prefers_handoff_column_id_over_legacy_state_key():
    adapter = FakeAdapter()
    adapter.seed_input(
        payload={
            "card_id": "card-579",
            "card_number": 579,
            "comment": "Proof attached",
            "handoff_column_id": "Ready to Ship",
            "handoff_state": "Synthesize & Verify",
        }
    )
    tracker = FakeTracker()

    result = FizzyWorkItemReporter(queue=WorkItemQueue(adapter), tracker=tracker).report_one()

    assert result.reported is True
    assert tracker.columns == [(579, "Ready to Ship")]


def test_reporter_failure_releases_result_item_as_failed():
    class BrokenTracker(FakeTracker):
        def create_comment(self, card_number, body):  # noqa: ARG002
            raise RuntimeError("fizzy write failed")

    adapter = FakeAdapter()
    adapter.seed_input(
        payload={
            "card_id": "card-579",
            "card_number": 579,
            "comment": "Proof attached",
            "handoff_state": "Synthesize & Verify",
        }
    )

    result = FizzyWorkItemReporter(queue=WorkItemQueue(adapter), tracker=BrokenTracker()).report_one()

    assert result.reported is False
    assert adapter.releases == [
        (
            "item-1",
            WorkItemState.FAILED,
            {
                "type": "APPLICATION",
                "code": "FIZZY_REPORTER_FAILED",
                "message": "fizzy write failed",
            },
        )
    ]
