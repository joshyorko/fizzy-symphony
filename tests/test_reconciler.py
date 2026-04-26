import json

from fizzy_symphony.board_contracts import ActiveRunSummary
from fizzy_symphony.reconciler import Reconciler, ReconcilerConfig


COLUMNS = [
    {"id": "ready", "name": "Ready"},
    {"id": "done", "name": "Done"},
]


def test_one_shot_tick_routes_spawns_and_writes_status_snapshot():
    client = _BoardClient(cards=[_golden(), _card(42), _card(43)])
    queue = _Queue()
    reconciler = Reconciler(
        config=ReconcilerConfig(board_id="board-1", workspace_path="/repo"),
        board_client=client,
        queue=queue,
        clock=_Clock(),
    )

    snapshot = reconciler.tick()

    assert client.calls[:2] == [("columns", "board-1"), ("cards", "board-1")]
    assert [payload["card"]["number"] for payload in queue.payloads] == [42, 43]
    assert snapshot.health == "ok"
    assert snapshot.status == "ok"
    assert snapshot.board_id == "board-1"
    assert snapshot.active_count == 0
    assert snapshot.last_tick_sequence == 1
    assert snapshot.last_tick_time == "2026-04-26T12:00:00+00:00"
    assert [decision["action"] for decision in snapshot.decisions] == ["spawn", "spawn"]
    assert snapshot.errors == []


def test_tick_respects_max_concurrency_before_spawning():
    client = _BoardClient(cards=[_golden(), _card(42), _card(43), _card(44)])
    queue = _Queue()
    runs = _RunState(active=[ActiveRunSummary(card_number=99, backend="codex", status="running")])
    reconciler = Reconciler(
        config=ReconcilerConfig(board_id="board-1", max_concurrent=2),
        board_client=client,
        queue=queue,
        run_state=runs,
    )

    snapshot = reconciler.tick()

    assert [payload["card"]["number"] for payload in queue.payloads] == [42]
    assert [decision["action"] for decision in snapshot.decisions] == [
        "spawn",
        "spawn",
        "spawn",
    ]
    assert snapshot.active_count == 1
    assert snapshot.decisions[0]["produced"] is True
    assert snapshot.decisions[1]["produced"] is False
    assert snapshot.decisions[1]["reason"] == "max_concurrency"


def test_write_status_json_to_path(tmp_path):
    reconciler = Reconciler(
        config=ReconcilerConfig(board_id="board-1"),
        board_client=_BoardClient(cards=[_golden(), _card(42)]),
        queue=_Queue(),
        clock=_Clock(),
    )
    reconciler.tick()

    path = tmp_path / "status.json"
    reconciler.write_status_json(path)

    data = json.loads(path.read_text())
    assert data["health"] == "ok"
    assert data["board_id"] == "board-1"
    assert data["active_runs"] == []
    assert data["recent_runs"] == []
    assert data["last_tick_sequence"] == 1


def test_tick_captures_error_in_status():
    reconciler = Reconciler(
        config=ReconcilerConfig(board_id="board-1"),
        board_client=_BrokenBoardClient(),
        queue=_Queue(),
        clock=_Clock(),
    )

    snapshot = reconciler.tick()

    assert snapshot.health == "error"
    assert snapshot.status == "error"
    assert snapshot.errors == [
        {
            "type": "RuntimeError",
            "message": "fizzy unavailable",
        }
    ]
    assert snapshot.last_tick_sequence == 1


def test_refresh_decision_handler_runs_before_status_snapshot():
    client = _BoardClient(cards=[_golden(7), _card(42)])
    handled = []
    reconciler = Reconciler(
        config=ReconcilerConfig(board_id="board-1"),
        board_client=client,
        queue=_Queue(),
        changed_card_numbers=lambda: [7],
        refresh_handler=lambda decision: handled.append(decision.dedupe_key),
    )

    snapshot = reconciler.tick()

    assert handled == ["board-1:7:refresh_golden_tickets"]
    assert snapshot.decisions[0]["action"] == "refresh_golden_tickets"
    assert snapshot.decisions[0]["handled"] is True


def test_tick_handles_cancel_before_refresh_when_decisions_are_mixed():
    client = _BoardClient(cards=[_golden(7), _card(42, closed=True)])
    runs = _RunState(active=[ActiveRunSummary(card_number=42, backend="codex", status="running")])
    handled = []
    reconciler = Reconciler(
        config=ReconcilerConfig(board_id="board-1"),
        board_client=client,
        run_state=runs,
        changed_card_numbers=lambda: [7],
        refresh_handler=lambda decision: handled.append(("refresh", decision.dedupe_key)),
        cancel_handler=lambda decision: handled.append(("cancel", decision.dedupe_key)),
    )

    snapshot = reconciler.tick()

    assert [decision["action"] for decision in snapshot.decisions] == [
        "refresh_golden_tickets",
        "cancel",
    ]
    assert handled == [
        ("cancel", "board-1:42:cancel"),
        ("refresh", "board-1:7:refresh_golden_tickets"),
    ]
    assert snapshot.decisions[0]["handled"] is True
    assert snapshot.decisions[1]["handled"] is True


def test_watch_loop_stops_after_injected_stop_condition_without_real_sleep():
    sleeps = []
    reconciler = Reconciler(
        config=ReconcilerConfig(board_id="board-1", poll_interval_seconds=11),
        board_client=_BoardClient(cards=[_golden(), _card(42)]),
        queue=_Queue(),
    )

    snapshots = reconciler.watch(
        stop_condition=lambda snapshot: snapshot.last_tick_sequence == 3,
        sleep=sleeps.append,
    )

    assert [snapshot.last_tick_sequence for snapshot in snapshots] == [1, 2, 3]
    assert sleeps == [11, 11]


class _Queue:
    def __init__(self):
        self.payloads = []

    def enqueue_input(self, payload):
        data = payload.to_dict()
        self.payloads.append(data)
        return f"item-{len(self.payloads)}"


class _BoardClient:
    def __init__(self, cards):
        self.cards = cards
        self.calls = []

    def column_list(self, board_id):
        self.calls.append(("columns", board_id))
        return COLUMNS

    def card_list(self, board_id):
        self.calls.append(("cards", board_id))
        return self.cards


class _BrokenBoardClient:
    def column_list(self, board_id):
        raise RuntimeError("fizzy unavailable")


class _RunState:
    def __init__(self, active=(), recent=()):
        self._active = tuple(active)
        self._recent = tuple(recent)

    def active_runs(self):
        return self._active

    def recent_runs(self):
        return self._recent


class _Clock:
    def __call__(self):
        return "2026-04-26T12:00:00+00:00"


def _card(number, *, column_id="ready", column_name="Ready", **overrides):
    card = {
        "id": f"card-{number}",
        "number": number,
        "title": f"Card {number}",
        "description": f"Description {number}",
        "golden": False,
        "tags": [],
        "column": {"id": column_id, "name": column_name},
    }
    card.update(overrides)
    return card


def _golden(number=1):
    return _card(
        number,
        id=f"golden-{number}",
        title="Golden route",
        description="Route these cards.",
        golden=True,
        tags=["agent-instructions", "codex"],
        steps=["Read card", "Run tests"],
    )
