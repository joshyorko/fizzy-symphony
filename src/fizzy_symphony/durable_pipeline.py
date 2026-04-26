"""Durable producer, worker, and reporter helpers for routed board work."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Protocol, Set

from .board_contracts import CompletionAction, CompletionPolicy, NormalizedCard, NormalizedComment
from .board_routing import RoutingDecision
from .prompting import build_board_prompt
from .runners import CodexRunRequest, CodexRunResult
from .workitem_queue import FizzyWorkItemPayload


JSONDict = Dict[str, Any]


class DedupeRegistry(Protocol):
    """Minimal registry surface for active or already-seen work keys."""

    def claim(self, key: str) -> bool: ...


class WorkItemSink(Protocol):
    """Queue boundary used by the durable producer."""

    def enqueue_input(self, payload: FizzyWorkItemPayload) -> str: ...


@dataclass
class InMemoryDedupeRegistry:
    """Small active/seen dedupe registry suitable for tests and local wiring."""

    active: Set[str] = field(default_factory=set)

    def claim(self, key: str) -> bool:
        if key in self.active:
            return False
        self.active.add(key)
        return True


@dataclass(frozen=True)
class ProducerResult:
    """Outcome for one routing decision considered by the producer."""

    dedupe_key: str
    enqueued: bool
    item_id: Optional[str] = None
    reason: str = ""


@dataclass(frozen=True)
class ReporterAction:
    """Planned or applied reporter mutation."""

    kind: str
    card_number: int
    value: str = ""


@dataclass(frozen=True)
class DurableReporterResult:
    """Structured reporter outcome that can be retried without rerunning workers."""

    card_number: Optional[int]
    reported: bool
    retryable: bool = False
    rerun_worker: bool = False
    reason: str = ""
    actions: Sequence[ReporterAction] = field(default_factory=tuple)


def produce_workitems(
    decisions: Sequence[RoutingDecision],
    *,
    queue: WorkItemSink,
    dedupe_registry: Optional[DedupeRegistry] = None,
    workspace_path: str = "",
    runtime: str = "sdk",
    model: Optional[str] = None,
    approval_policy: Optional[str] = None,
    sandbox_mode: Optional[str] = None,
    timeout_seconds: Optional[float] = None,
    service_context: object = None,
) -> Sequence[ProducerResult]:
    """Enqueue one durable workitem for each non-duplicate spawn decision."""

    results = []
    for decision in decisions:
        if decision.action != "spawn":
            continue
        dedupe_key = decision.dedupe_key
        if dedupe_registry is not None and not dedupe_registry.claim(dedupe_key):
            results.append(ProducerResult(dedupe_key=dedupe_key, enqueued=False, reason="duplicate"))
            continue

        payload = build_workitem_payload(
            decision,
            workspace_path=workspace_path,
            runtime=runtime,
            model=model,
            approval_policy=approval_policy,
            sandbox_mode=sandbox_mode,
            timeout_seconds=timeout_seconds,
            service_context=service_context,
        )
        item_id = queue.enqueue_input(DurableWorkItemPayload.from_payload(payload))
        results.append(ProducerResult(dedupe_key=dedupe_key, enqueued=True, item_id=str(item_id)))
    return tuple(results)


class DurableWorkItemPayload(FizzyWorkItemPayload):
    """Fizzy work item payload that preserves durable routing metadata."""

    def __init__(self, payload: Mapping[str, Any]) -> None:
        data = dict(payload)
        super().__init__(
            source=str(data.get("source") or "fizzy"),
            card=dict(_mapping(data.get("card"))),
            workflow=dict(_mapping(data.get("workflow"))),
            runner=dict(_mapping(data.get("runner"))),
        )
        object.__setattr__(self, "_payload", data)

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "DurableWorkItemPayload":
        return cls(payload)

    def to_dict(self) -> JSONDict:
        return dict(self._payload)


def build_workitem_payload(
    decision: RoutingDecision,
    *,
    workspace_path: str = "",
    runtime: str = "sdk",
    model: Optional[str] = None,
    approval_policy: Optional[str] = None,
    sandbox_mode: Optional[str] = None,
    timeout_seconds: Optional[float] = None,
    service_context: object = None,
) -> JSONDict:
    """Build the SDK-first durable workitem payload for a spawn decision."""

    if decision.card is None:
        raise ValueError("spawn decision requires a card")
    if decision.route is None:
        raise ValueError("spawn decision requires a route")

    comments = tuple(decision.comments or ())
    prompt = build_board_prompt(
        service_context=service_context or {"summary": "No service context provided."},
        golden_ticket=decision.route,
        work_card=decision.card,
        comments=comments,
    )
    completion_policy = decision.completion_policy or decision.route.completion_policy
    runner: JSONDict = {
        "kind": runtime,
        "workspace": workspace_path,
    }
    if model is not None:
        runner["model"] = model
    if approval_policy is not None:
        runner["approval_policy"] = approval_policy
    if sandbox_mode is not None:
        runner["sandbox_mode"] = sandbox_mode
    if timeout_seconds is not None:
        runner["timeout_seconds"] = timeout_seconds

    return {
        "source": "fizzy",
        "dedupe_key": decision.dedupe_key,
        "card": _card_dict(decision.card),
        "route": _route_dict(decision.route),
        "prompt": prompt,
        "workflow": {
            "workspace": workspace_path,
            "backend": decision.backend or decision.route.backend,
        },
        "runner": runner,
        "completion_policy": _completion_policy_dict(completion_policy),
        "comments": [_comment_dict(comment) for comment in comments],
    }


def build_run_request_from_payload(payload: Mapping[str, Any]) -> CodexRunRequest:
    """Build a CodexRunRequest directly from a durable workitem payload."""

    card = _mapping(payload.get("card"))
    runner = _mapping(payload.get("runner"))
    workflow = _mapping(payload.get("workflow"))
    timeout_seconds = _optional_float(runner.get("timeout_seconds"))
    env = runner.get("env") or {}
    if not isinstance(env, Mapping):
        env = {}

    return CodexRunRequest(
        prompt=str(payload.get("prompt") or ""),
        command=runner.get("command"),
        workspace=_optional_string(runner.get("workspace") or workflow.get("workspace")),
        model=_optional_string(runner.get("model")),
        approval_policy=_optional_string(runner.get("approval_policy")),
        sandbox_mode=_optional_string(runner.get("sandbox_mode")),
        timeout_seconds=timeout_seconds,
        env={str(key): str(value) for key, value in env.items()},
        card_number=_optional_int(card.get("number")),
        metadata={
            "source": payload.get("source"),
            "dedupe_key": payload.get("dedupe_key"),
            "card": dict(card),
            "route": dict(_mapping(payload.get("route"))),
            "workflow": dict(workflow),
            "runner": dict(runner),
            "completion_policy": dict(_mapping(payload.get("completion_policy"))),
        },
    )


def build_worker_result_payload(
    payload: Mapping[str, Any],
    result: CodexRunResult,
) -> JSONDict:
    """Convert a runner result into a durable reporter payload."""

    return {
        "source": payload.get("source", "fizzy"),
        "dedupe_key": payload.get("dedupe_key", ""),
        "card": dict(_mapping(payload.get("card"))),
        "route": dict(_mapping(payload.get("route"))),
        "completion_policy": dict(_mapping(payload.get("completion_policy"))),
        "result": result.to_workitem_result(),
    }


@dataclass(frozen=True)
class DurableReporter:
    """Apply worker output to a board client after rechecking current card state."""

    client: object
    card_reader: Callable[[int], object]

    def report(self, output_payload: Mapping[str, Any]) -> DurableReporterResult:
        card = _mapping(output_payload.get("card"))
        route = _mapping(output_payload.get("route"))
        result = _mapping(output_payload.get("result"))
        card_number = _optional_int(card.get("number"))
        if card_number is None:
            return DurableReporterResult(
                card_number=None,
                reported=False,
                retryable=False,
                reason="missing_card_number",
            )

        try:
            current_card = self.card_reader(card_number)
        except Exception:
            return DurableReporterResult(
                card_number=card_number,
                reported=False,
                retryable=True,
                rerun_worker=False,
                reason="card_read_failed",
            )
        if not _card_matches_route(current_card, route):
            return DurableReporterResult(
                card_number=card_number,
                reported=False,
                retryable=False,
                reason="stale_card",
            )

        actions = _actions_for_output(card_number, output_payload)
        try:
            for index, action in enumerate(actions):
                _apply_action(self.client, action)
        except Exception:
            return DurableReporterResult(
                card_number=card_number,
                reported=False,
                retryable=True,
                rerun_worker=False,
                reason="reporter_failed",
                actions=tuple(actions[index:]),
            )

        return DurableReporterResult(
            card_number=card_number,
            reported=True,
            retryable=False,
            rerun_worker=False,
            actions=tuple(actions),
            reason="reported",
        )


def _actions_for_output(card_number: int, output_payload: Mapping[str, Any]) -> Sequence[ReporterAction]:
    result = _mapping(output_payload.get("result"))
    pending_actions = output_payload.get("pending_report_actions") or result.get("pending_report_actions")
    if pending_actions:
        return tuple(
            _reporter_action_from_payload(action, fallback_card_number=card_number)
            for action in pending_actions
        )

    comment = _result_comment(result)
    success = bool(result.get("success"))
    actions = [ReporterAction("comment", card_number, comment)]
    if not success:
        actions.append(ReporterAction("tag", card_number, "pi-error"))
        actions.append(ReporterAction("failed", card_number, comment))
        return tuple(actions)

    policy = _mapping(output_payload.get("completion_policy"))
    action = str(policy.get("action") or CompletionAction.COMMENT.value)
    if action == CompletionAction.CLOSE.value:
        actions.append(ReporterAction("close", card_number))
    elif action == CompletionAction.MOVE.value:
        actions.append(ReporterAction("move", card_number, str(policy.get("target_column_id") or "")))
    return tuple(actions)


def _reporter_action_from_payload(action: object, *, fallback_card_number: int) -> ReporterAction:
    if isinstance(action, ReporterAction):
        return action
    data = _mapping(action)
    return ReporterAction(
        kind=str(data.get("kind") or ""),
        card_number=_optional_int(data.get("card_number")) or fallback_card_number,
        value=str(data.get("value") or ""),
    )


def _apply_action(client: object, action: ReporterAction) -> None:
    if action.kind == "comment":
        client.create_comment(action.card_number, action.value)
    elif action.kind == "close":
        client.close_card(action.card_number)
    elif action.kind == "move":
        client.move_card_to_column(action.card_number, action.value)
    elif action.kind == "tag":
        client.add_tag(action.card_number, action.value)
    elif action.kind == "failed":
        marker = getattr(client, "mark_failed", None) or getattr(client, "report_failed", None)
        if not callable(marker):
            raise AttributeError("reporter client must provide mark_failed or report_failed")
        marker(action.card_number, action.value)
    else:
        raise ValueError(f"unsupported reporter action: {action.kind!r}")


def _card_matches_route(card: object, route: Mapping[str, Any]) -> bool:
    if card is None:
        return False
    expected_board_id = str(route.get("board_id") or "")
    if expected_board_id and _card_board_id(card) != expected_board_id:
        return False
    expected_column_id = str(route.get("column_id") or "")
    if not expected_column_id:
        return True
    return _object_value(card, "column_id") == expected_column_id


def _card_board_id(card: object) -> str:
    direct_board_id = _object_value(card, "board_id")
    if direct_board_id not in (None, ""):
        return str(direct_board_id)
    raw = _object_value(card, "raw")
    if isinstance(raw, Mapping):
        board = raw.get("board")
        if isinstance(board, Mapping):
            return str(board.get("id") or "")
        return str(raw.get("board_id") or "")
    return ""


def _result_comment(result: Mapping[str, Any]) -> str:
    return str(
        result.get("comment")
        or result.get("final_response")
        or result.get("stderr")
        or "Codex work item completed."
    )


def _card_dict(card: NormalizedCard) -> JSONDict:
    return {
        "id": card.id,
        "number": card.number,
        "title": card.title,
        "description": card.description,
        "tags": list(card.tags),
        "steps": list(card.steps),
        "column_id": card.column_id,
        "column_name": card.column_name,
        "golden": card.golden,
        "raw": dict(card.raw),
    }


def _route_dict(route: object) -> JSONDict:
    return {
        "board_id": _object_value(route, "board_id"),
        "column_id": _object_value(route, "column_id"),
        "column_name": _object_value(route, "column_name"),
        "golden_ticket_card_number": _object_value(route, "card_number"),
        "golden_ticket_card_title": _object_value(route, "card_title"),
        "golden_ticket_card_description": _object_value(route, "card_description"),
        "golden_ticket_card_tags": list(_object_value(route, "card_tags") or ()),
        "steps": list(_object_value(route, "steps") or ()),
        "backend": _object_value(route, "backend"),
    }


def _comment_dict(comment: NormalizedComment) -> JSONDict:
    return {
        "id": comment.id,
        "body": comment.body,
        "author": comment.author,
        "created_at": comment.created_at,
    }


def _completion_policy_dict(policy: CompletionPolicy) -> JSONDict:
    data = {"action": policy.action.value}
    if policy.action == CompletionAction.MOVE:
        data["target_column_id"] = policy.target_column_id
        data["target_column_name"] = policy.target_column_name
    return data


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    return {}


def _object_value(value: object, name: str) -> object:
    if isinstance(value, Mapping):
        return value.get(name)
    return getattr(value, name, None)


def _optional_string(value: object) -> Optional[str]:
    if value in (None, ""):
        return None
    return str(value)


def _optional_int(value: object) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _optional_float(value: object) -> Optional[float]:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None
