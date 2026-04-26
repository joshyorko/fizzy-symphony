"""Polling-first reconciliation and status helpers for board-routed work."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from .board_contracts import ActiveRunSummary
from .board_routing import RoutingDecision, route_board_cards
from .durable_pipeline import DedupeRegistry, ProducerResult, WorkItemSink, produce_workitems


JSONDict = Dict[str, Any]
RunLike = Union[ActiveRunSummary, Mapping[str, Any], object]


@dataclass(frozen=True)
class ReconcilerConfig:
    """Configuration for one polling reconciler instance."""

    board_id: str
    max_concurrent: int = 5
    poll_interval_seconds: float = 30
    workspace_path: str = ""
    runtime: str = "sdk"
    model: Optional[str] = None
    approval_policy: Optional[str] = None
    sandbox_mode: Optional[str] = None
    timeout_seconds: Optional[float] = None


@dataclass(frozen=True)
class ReconcilerStatusSnapshot:
    """Serializable status payload describing the latest reconciliation tick."""

    health: str
    status: str
    board_id: str
    active_runs: Sequence[JSONDict]
    recent_runs: Sequence[JSONDict]
    active_count: int
    last_tick_time: str
    last_tick_sequence: int
    decisions: Sequence[JSONDict] = field(default_factory=tuple)
    errors: Sequence[JSONDict] = field(default_factory=tuple)

    def to_dict(self) -> JSONDict:
        return {
            "health": self.health,
            "status": self.status,
            "board_id": self.board_id,
            "active_runs": [dict(run) for run in self.active_runs],
            "recent_runs": [dict(run) for run in self.recent_runs],
            "active_count": self.active_count,
            "last_tick_time": self.last_tick_time,
            "last_tick_sequence": self.last_tick_sequence,
            "decisions": [dict(decision) for decision in self.decisions],
            "errors": [dict(error) for error in self.errors],
        }


class Reconciler:
    """Poll a Fizzy board, route cards, enqueue work, and keep a status snapshot."""

    def __init__(
        self,
        *,
        config: ReconcilerConfig,
        board_client: object,
        queue: Optional[WorkItemSink] = None,
        run_state: object = None,
        dedupe_registry: Optional[DedupeRegistry] = None,
        changed_card_numbers: Optional[Callable[[], Sequence[Union[int, str]]]] = None,
        refresh_handler: Optional[Callable[[RoutingDecision], object]] = None,
        cancel_handler: Optional[Callable[[RoutingDecision], object]] = None,
        clock: Optional[Callable[[], object]] = None,
        service_context: object = None,
    ) -> None:
        self.config = config
        self.board_client = board_client
        self.queue = queue
        self.run_state = run_state
        self.dedupe_registry = dedupe_registry
        self.changed_card_numbers = changed_card_numbers
        self.refresh_handler = refresh_handler
        self.cancel_handler = cancel_handler
        self.clock = clock or _utc_now
        self.service_context = service_context
        self.last_status = _empty_status(config.board_id)
        self._sequence = 0

    def tick(self) -> ReconcilerStatusSnapshot:
        """Run one reconciliation pass and return the updated status snapshot."""

        self._sequence += 1
        last_tick_time = _clock_value(self.clock)
        errors: List[JSONDict] = []
        decision_entries: List[JSONDict] = []
        active_runs: Sequence[JSONDict] = ()
        recent_runs: Sequence[JSONDict] = ()

        try:
            columns = _read_columns(self.board_client, self.config.board_id)
            cards = _read_cards(self.board_client, self.config.board_id)
            active_runs = _runs_from_state(self.run_state, "active_runs")
            recent_runs = _runs_from_state(self.run_state, "recent_runs")
            decisions = route_board_cards(
                board_id=self.config.board_id,
                cards=cards,
                columns=columns,
                active_card_numbers=_card_numbers(active_runs),
                changed_card_numbers=_changed_numbers(self.changed_card_numbers),
            )
            decision_entries = [_decision_entry(decision) for decision in decisions]
            self._produce_spawn_work(decisions, decision_entries, len(active_runs), errors)
            self._handle_refresh_and_cancel(decisions, decision_entries, errors)
        except Exception as error:  # status must survive transient board/client failures
            errors.append(_error_dict(error))

        health = "error" if errors else "ok"
        self.last_status = ReconcilerStatusSnapshot(
            health=health,
            status=health,
            board_id=self.config.board_id,
            active_runs=list(active_runs),
            recent_runs=list(recent_runs),
            active_count=len(active_runs),
            last_tick_time=last_tick_time,
            last_tick_sequence=self._sequence,
            decisions=list(decision_entries),
            errors=list(errors),
        )
        return self.last_status

    def watch(
        self,
        *,
        stop_condition: Optional[Callable[[ReconcilerStatusSnapshot], bool]] = None,
        sleep: Optional[Callable[[float], object]] = None,
    ) -> Sequence[ReconcilerStatusSnapshot]:
        """Run ticks until an injected stop condition returns true."""

        sleeper = sleep or _sleep
        snapshots: List[ReconcilerStatusSnapshot] = []
        while True:
            snapshot = self.tick()
            snapshots.append(snapshot)
            if stop_condition is not None and stop_condition(snapshot):
                return list(snapshots)
            sleeper(self.config.poll_interval_seconds)

    def write_status_json(self, path: Union[str, Path]) -> None:
        """Write the most recent status snapshot as pretty JSON."""

        status_path = Path(path)
        status_path.write_text(json.dumps(self.last_status.to_dict(), indent=2, sort_keys=True) + "\n")

    def _produce_spawn_work(
        self,
        decisions: Sequence[RoutingDecision],
        entries: Sequence[JSONDict],
        active_count: int,
        errors: List[JSONDict],
    ) -> None:
        remaining_capacity = max(0, self.config.max_concurrent - active_count)
        spawned = 0
        for decision, entry in zip(decisions, entries):
            if decision.action != "spawn":
                continue
            if spawned >= remaining_capacity:
                entry["produced"] = False
                entry["reason"] = "max_concurrency"
                continue
            if self.queue is None:
                entry["produced"] = False
                entry["reason"] = "missing_queue"
                continue
            try:
                results = produce_workitems(
                    (decision,),
                    queue=self.queue,
                    dedupe_registry=self.dedupe_registry,
                    workspace_path=self.config.workspace_path,
                    runtime=self.config.runtime,
                    model=self.config.model,
                    approval_policy=self.config.approval_policy,
                    sandbox_mode=self.config.sandbox_mode,
                    timeout_seconds=self.config.timeout_seconds,
                    service_context=self.service_context,
                )
            except Exception as error:
                entry["produced"] = False
                entry["reason"] = "producer_error"
                errors.append(_error_dict(error))
                continue
            result = results[0] if results else None
            _apply_producer_result(entry, result)
            if result is not None and result.enqueued:
                spawned += 1

    def _handle_refresh_and_cancel(
        self,
        decisions: Sequence[RoutingDecision],
        entries: Sequence[JSONDict],
        errors: List[JSONDict],
    ) -> None:
        for action, handler in (
            ("cancel", self.cancel_handler),
            ("refresh_golden_tickets", self.refresh_handler),
        ):
            if handler is None:
                continue
            for decision, entry in zip(decisions, entries):
                if decision.action != action:
                    continue
                try:
                    handler(decision)
                except Exception as error:
                    entry["handled"] = False
                    entry["reason"] = "handler_error"
                    errors.append(_error_dict(error))
                    continue
                entry["handled"] = True


def _read_columns(board_client: object, board_id: str) -> Sequence[Mapping[str, Any]]:
    reader = getattr(board_client, "column_list", None) or getattr(board_client, "list_columns", None)
    if not callable(reader):
        raise AttributeError("board_client must provide column_list or list_columns")
    return tuple(reader(board_id))


def _read_cards(board_client: object, board_id: str) -> Sequence[Mapping[str, Any]]:
    reader = getattr(board_client, "card_list", None) or getattr(board_client, "list_cards", None)
    if not callable(reader):
        raise AttributeError("board_client must provide card_list or list_cards")
    return tuple(reader(board_id))


def _runs_from_state(run_state: object, method_name: str) -> Sequence[JSONDict]:
    if run_state is None:
        return ()
    reader = getattr(run_state, method_name, None)
    if not callable(reader):
        return ()
    return tuple(_run_dict(run) for run in reader())


def _run_dict(run: RunLike) -> JSONDict:
    if isinstance(run, ActiveRunSummary):
        return {
            "card_number": run.card_number,
            "backend": run.backend,
            "status": run.status,
            "summary": run.summary,
            "route_column_id": run.route_column_id,
        }
    if isinstance(run, Mapping):
        return dict(run)
    return {
        "card_number": getattr(run, "card_number", None),
        "backend": getattr(run, "backend", ""),
        "status": getattr(run, "status", ""),
        "summary": getattr(run, "summary", ""),
        "route_column_id": getattr(run, "route_column_id", ""),
    }


def _card_numbers(runs: Sequence[Mapping[str, Any]]) -> Sequence[int]:
    numbers = []
    for run in runs:
        try:
            number = int(run.get("card_number") or 0)
        except (TypeError, ValueError):
            continue
        if number > 0:
            numbers.append(number)
    return tuple(numbers)


def _changed_numbers(provider: Optional[Callable[[], Sequence[Union[int, str]]]]) -> Sequence[Union[int, str]]:
    if provider is None:
        return ()
    return tuple(provider())


def _decision_entry(decision: RoutingDecision) -> JSONDict:
    entry: JSONDict = {
        "action": decision.action,
        "reason": decision.reason,
        "dedupe_key": decision.dedupe_key,
    }
    if decision.card is not None:
        entry["card_number"] = decision.card.number
        entry["card_title"] = decision.card.title
    if decision.route is not None:
        entry["route_column_id"] = decision.route.column_id
        entry["backend"] = decision.backend or decision.route.backend
    return entry


def _apply_producer_result(entry: JSONDict, result: Optional[ProducerResult]) -> None:
    if result is None:
        entry["produced"] = False
        entry["reason"] = "no_result"
        return
    entry["produced"] = result.enqueued
    if result.item_id is not None:
        entry["item_id"] = result.item_id
    if result.reason:
        entry["reason"] = result.reason


def _error_dict(error: Exception) -> JSONDict:
    return {"type": type(error).__name__, "message": str(error)}


def _clock_value(clock: Callable[[], object]) -> str:
    value = clock()
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _sleep(seconds: float) -> None:
    import time

    time.sleep(seconds)


def _empty_status(board_id: str) -> ReconcilerStatusSnapshot:
    return ReconcilerStatusSnapshot(
        health="unknown",
        status="starting",
        board_id=board_id,
        active_runs=[],
        recent_runs=[],
        active_count=0,
        last_tick_time="",
        last_tick_sequence=0,
        decisions=[],
        errors=[],
    )
