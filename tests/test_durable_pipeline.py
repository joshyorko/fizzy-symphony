from dataclasses import replace

from fizzy_symphony.board_contracts import (
    CompletionAction,
    CompletionPolicy,
    GoldenTicketRoute,
    NormalizedCard,
    NormalizedComment,
)
from fizzy_symphony.board_routing import RoutingDecision
from fizzy_symphony.durable_pipeline import (
    DurableReporter,
    DurableWorkItemPayload,
    InMemoryDedupeRegistry,
    ReporterAction,
    build_run_request_from_payload,
    build_worker_result_payload,
    produce_workitems,
)
from fizzy_symphony.runners import CodexRunResult
from fizzy_symphony.workitem_queue import FizzyWorkItemPayload, WorkItemQueue


def test_producer_dedupes_spawn_decisions_with_active_registry():
    queue = _Queue()
    registry = InMemoryDedupeRegistry(active={"board-1:42:ready:7"})

    results = produce_workitems(
        [_decision(42), _decision(43)],
        queue=queue,
        dedupe_registry=registry,
        workspace_path="/repo",
    )

    assert [result.enqueued for result in results] == [False, True]
    assert [item["dedupe_key"] for item in queue.payloads] == ["board-1:43:ready:7"]
    assert registry.claim("board-1:43:ready:7") is False


def test_producer_uses_atomic_dedupe_claim_only_once_per_spawn():
    queue = _Queue()
    registry = _ClaimOnlyRegistry(leased={"board-1:42:ready:7"})

    results = produce_workitems(
        [_decision(42), _decision(43)],
        queue=queue,
        dedupe_registry=registry,
        workspace_path="/repo",
    )

    assert [result.reason for result in results] == ["duplicate", ""]
    assert registry.claimed_keys == ["board-1:42:ready:7", "board-1:43:ready:7"]
    assert [item["card"]["number"] for item in queue.payloads] == [43]


def test_producer_enqueues_real_fizzy_workitem_payload_through_workitem_queue():
    adapter = _SeedAdapter()
    queue = WorkItemQueue(adapter)

    results = produce_workitems([_decision(42)], queue=queue, workspace_path="/repo")

    assert results[0].item_id == "item-1"
    assert adapter.seeded[0]["dedupe_key"] == "board-1:42:ready:7"
    assert adapter.seeded[0]["workflow"]["backend"] == "codex"
    assert adapter.seeded[0]["route"]["board_id"] == "board-1"


def test_producer_includes_route_context_in_payload():
    queue = _Queue()
    decision = _decision(
        42,
        comments=(NormalizedComment(id="c1", body="Watch auth", author="Josh"),),
    )

    produce_workitems([decision], queue=queue, workspace_path="/repo", runtime="sdk")

    payload = queue.payloads[0]
    assert payload["source"] == "fizzy"
    assert payload["card"]["number"] == 42
    assert payload["route"]["board_id"] == "board-1"
    assert payload["route"]["golden_ticket_card_number"] == 7
    assert payload["route"]["column_id"] == "ready"
    assert payload["prompt"].startswith("## Service Context")
    assert payload["workflow"]["workspace"] == "/repo"
    assert payload["workflow"]["backend"] == "codex"
    assert payload["runner"]["kind"] == "sdk"
    assert payload["completion_policy"] == {"action": "comment"}
    assert payload["comments"] == [{"id": "c1", "body": "Watch auth", "author": "Josh", "created_at": ""}]


def test_worker_helper_builds_sdk_first_request_and_preserves_runner_metadata():
    payload = _payload(completion_policy=CompletionPolicy(action=CompletionAction.CLOSE))

    request = build_run_request_from_payload(payload)
    output = build_worker_result_payload(
        payload,
        CodexRunResult(
            success=True,
            final_response="Implemented and tested.",
            thread_id="thread-123",
            artifacts={"run_id": "run-456"},
            raw_metadata={"runner": "codex_sdk", "turn_id": "run-456"},
        ),
    )

    assert request.prompt == payload["prompt"]
    assert request.workspace == "/repo"
    assert request.model == "gpt-5-codex"
    assert request.approval_policy == "never"
    assert request.card_number == 42
    assert request.metadata["route"]["column_id"] == "ready"
    assert output["result"]["thread_id"] == "thread-123"
    assert output["result"]["artifacts"]["run_id"] == "run-456"
    assert output["result"]["raw_metadata"]["turn_id"] == "run-456"
    assert output["completion_policy"] == {"action": "close"}


def test_reporter_success_comment_only_posts_comment_without_completion_mutation():
    client = _ReporterClient()
    reporter = DurableReporter(client=client, card_reader=client.get_card)

    result = reporter.report(_result_payload(success=True, completion_policy={"action": "comment"}))

    assert result.reported is True
    assert result.retryable is False
    assert client.actions == [("comment", 42, "Implemented and tested.")]


def test_reporter_success_close_posts_comment_and_closes_card():
    client = _ReporterClient()
    reporter = DurableReporter(client=client, card_reader=client.get_card)

    result = reporter.report(_result_payload(success=True, completion_policy={"action": "close"}))

    assert result.reported is True
    assert client.actions == [
        ("comment", 42, "Implemented and tested."),
        ("close", 42),
    ]


def test_reporter_success_move_to_column_posts_comment_and_moves_card():
    client = _ReporterClient()
    reporter = DurableReporter(client=client, card_reader=client.get_card)

    result = reporter.report(
        _result_payload(
            success=True,
            completion_policy={
                "action": "move",
                "target_column_id": "done",
                "target_column_name": "Done",
            },
        )
    )

    assert result.reported is True
    assert client.actions == [
        ("comment", 42, "Implemented and tested."),
        ("move", 42, "done"),
    ]


def test_reporter_failure_comments_tags_error_and_marks_failed_state():
    client = _ReporterClient()
    reporter = DurableReporter(client=client, card_reader=client.get_card)

    result = reporter.report(_result_payload(success=False, comment="Tests failed."))

    assert result.reported is True
    assert client.actions == [
        ("comment", 42, "Tests failed."),
        ("tag", 42, "pi-error"),
        ("failed", 42, "Tests failed."),
    ]


def test_reporter_stale_card_guard_rechecks_before_mutating():
    client = _ReporterClient(card=_card(column_id="someone-moved-it"))
    reporter = DurableReporter(client=client, card_reader=client.get_card)

    result = reporter.report(_result_payload(success=True))

    assert result.reported is False
    assert result.retryable is False
    assert result.reason == "stale_card"
    assert client.actions == []


def test_reporter_wrong_board_guard_rechecks_before_mutating():
    client = _ReporterClient(card=_card(board_id="wrong-board"))
    reporter = DurableReporter(client=client, card_reader=client.get_card)

    result = reporter.report(_result_payload(success=True))

    assert result.reported is False
    assert result.retryable is False
    assert result.reason == "stale_card"
    assert client.actions == []


def test_reporter_card_read_error_is_retryable_without_rerunning_worker():
    client = _ReporterClient(fail_on="read")
    reporter = DurableReporter(client=client, card_reader=client.get_card)

    result = reporter.report(_result_payload(success=True))

    assert result.reported is False
    assert result.retryable is True
    assert result.rerun_worker is False
    assert result.reason == "card_read_failed"
    assert client.actions == []


def test_reporter_failure_is_retryable_without_rerunning_worker():
    client = _ReporterClient(fail_on="comment")
    reporter = DurableReporter(client=client, card_reader=client.get_card)

    result = reporter.report(_result_payload(success=True))

    assert result.reported is False
    assert result.retryable is True
    assert result.rerun_worker is False
    assert result.reason == "reporter_failed"


def test_reporter_retry_actions_exclude_already_applied_comment_after_partial_failure():
    client = _ReporterClient(fail_on="move")
    reporter = DurableReporter(client=client, card_reader=client.get_card)

    result = reporter.report(
        _result_payload(
            success=True,
            completion_policy={
                "action": "move",
                "target_column_id": "done",
                "target_column_name": "Done",
            },
        )
    )

    assert result.reported is False
    assert result.retryable is True
    assert result.rerun_worker is False
    assert client.actions == [("comment", 42, "Implemented and tested.")]
    assert result.actions == (ReporterAction("move", 42, "done"),)


def test_reporter_retry_uses_pending_actions_without_reposting_comment():
    first_client = _ReporterClient(fail_on="move")
    first_reporter = DurableReporter(client=first_client, card_reader=first_client.get_card)
    payload = _result_payload(
        success=True,
        completion_policy={
            "action": "move",
            "target_column_id": "done",
            "target_column_name": "Done",
        },
    )

    first_result = first_reporter.report(payload)

    retry_payload = dict(payload)
    retry_payload["pending_report_actions"] = [
        {"kind": action.kind, "card_number": action.card_number, "value": action.value}
        for action in first_result.actions
    ]
    retry_client = _ReporterClient()
    retry_reporter = DurableReporter(client=retry_client, card_reader=retry_client.get_card)

    retry_result = retry_reporter.report(retry_payload)

    assert first_client.actions == [("comment", 42, "Implemented and tested.")]
    assert retry_result.reported is True
    assert retry_result.actions == (ReporterAction("move", 42, "done"),)
    assert retry_client.actions == [("move", 42, "done")]


class _Queue:
    def __init__(self):
        self.payloads = []

    def enqueue_input(self, payload):
        assert isinstance(payload, FizzyWorkItemPayload)
        assert isinstance(payload, DurableWorkItemPayload)
        self.payloads.append(payload.to_dict())
        return f"item-{len(self.payloads)}"


class _SeedAdapter:
    def __init__(self):
        self.seeded = []

    def seed_input(self, payload):
        self.seeded.append(payload)
        return f"item-{len(self.seeded)}"

    def reserve_input(self):
        raise NotImplementedError

    def release_input(self, item_id, state, exception=None):
        raise NotImplementedError

    def create_output(self, parent_id, payload=None):
        raise NotImplementedError

    def load_payload(self, item_id):
        raise NotImplementedError

    def save_payload(self, item_id, payload):
        raise NotImplementedError


class _ClaimOnlyRegistry:
    def __init__(self, leased=()):
        self.leased = set(leased)
        self.claimed_keys = []

    def claim(self, key):
        self.claimed_keys.append(key)
        if key in self.leased:
            return False
        self.leased.add(key)
        return True


class _ReporterClient:
    def __init__(self, card=None, fail_on=""):
        self.card = card or _card()
        self.fail_on = fail_on
        self.actions = []

    def get_card(self, card_number):
        self._maybe_fail("read")
        assert card_number == 42
        return self.card

    def create_comment(self, card_number, body):
        self._maybe_fail("comment")
        self.actions.append(("comment", card_number, body))

    def close_card(self, card_number):
        self._maybe_fail("close")
        self.actions.append(("close", card_number))

    def move_card_to_column(self, card_number, column_id):
        self._maybe_fail("move")
        self.actions.append(("move", card_number, column_id))

    def add_tag(self, card_number, tag):
        self._maybe_fail("tag")
        self.actions.append(("tag", card_number, tag))

    def mark_failed(self, card_number, message):
        self._maybe_fail("failed")
        self.actions.append(("failed", card_number, message))

    def _maybe_fail(self, operation):
        if self.fail_on == operation:
            raise RuntimeError("fizzy unavailable")


def _decision(card_number, comments=()):
    route = GoldenTicketRoute(
        board_id="board-1",
        column_id="ready",
        column_name="Ready",
        card_number=7,
        card_title="Agent instructions",
        card_description="Use Codex.",
        card_tags=("agent-instructions", "codex"),
        steps=("Make the change", "Run tests"),
        backend="codex",
        completion_policy=CompletionPolicy(),
    )
    return RoutingDecision(
        action="spawn",
        card=_card(number=card_number),
        route=route,
        backend="codex",
        completion_policy=route.completion_policy,
        comments=comments,
        dedupe_key=f"board-1:{card_number}:ready:7",
    )


def _card(number=42, column_id="ready", board_id="board-1"):
    return NormalizedCard(
        id=f"card-{number}",
        number=number,
        title=f"Card {number}",
        description="Fix the thing.",
        tags=("bug",),
        column_id=column_id,
        column_name="Ready",
        raw={"board_id": board_id},
    )


def _payload(completion_policy=None):
    queue = _Queue()
    decision = _decision(42)
    if completion_policy is not None:
        route = replace(decision.route, completion_policy=completion_policy)
        decision = replace(decision, route=route, completion_policy=completion_policy)
    produce_workitems([decision], queue=queue, workspace_path="/repo", runtime="sdk")
    payload = queue.payloads[0]
    payload["runner"].update({"model": "gpt-5-codex", "approval_policy": "never"})
    return payload


def _result_payload(success=True, completion_policy=None, comment="Implemented and tested."):
    payload = _payload()
    if completion_policy is not None:
        payload["completion_policy"] = completion_policy
    return {
        "source": "fizzy",
        "card": dict(payload["card"]),
        "route": dict(payload["route"]),
        "completion_policy": dict(payload["completion_policy"]),
        "result": {"success": success, "comment": comment, "final_response": comment},
    }
