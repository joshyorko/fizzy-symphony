"""Fizzy -> Workitems -> Codex -> Fizzy pipeline helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Optional, Protocol

from .models import FizzyCard
from .tracker import TrackerAdapter
from .workitem_queue import FizzyWorkItemPayload, JSONDict, WorkItemQueue


class WorkItemRunner(Protocol):
    def __call__(self, payload: FizzyWorkItemPayload) -> JSONDict: ...


@dataclass(frozen=True)
class WorkerResult:
    item_id: str
    output_id: Optional[str]
    succeeded: bool


@dataclass(frozen=True)
class ReporterResult:
    item_id: str
    reported: bool


@dataclass
class FizzyWorkItemProducer:
    """Enqueue eligible Fizzy cards as durable work items."""

    tracker: TrackerAdapter
    queue: WorkItemQueue
    board_id: Optional[str]
    prompt_template: str = ""
    allowed_paths: Optional[List[str]] = None
    handoff_column: str = "Synthesize & Verify"
    runner_command: str = "codex exec --json"

    def produce(self) -> List[str]:
        item_ids: List[str] = []
        for card in self.tracker.fetch_candidate_cards():
            payload = self._payload_for(card)
            item_ids.append(self.queue.enqueue_input(payload))
        return item_ids

    def _payload_for(self, card: FizzyCard) -> FizzyWorkItemPayload:
        return FizzyWorkItemPayload.from_card(
            card,
            board_id=self.board_id,
            prompt_template=self.prompt_template,
            allowed_paths=list(self.allowed_paths or []),
            handoff_column=self.handoff_column,
            runner_command=self.runner_command,
        )


@dataclass
class CodexWorkItemWorker:
    """Reserve one work item and pass it to a configured Codex runner."""

    queue: WorkItemQueue
    runner: WorkItemRunner
    failure_code: str = "CODEX_WORKER_FAILED"

    def work_one(self) -> WorkerResult:
        item = self.queue.reserve()
        payload = FizzyWorkItemPayload.from_dict(item.payload)
        try:
            runner_result = self.runner(payload)
        except Exception as exc:
            self.queue.fail(item.id, message=str(exc), code=self.failure_code)
            return WorkerResult(item_id=item.id, output_id=None, succeeded=False)

        output_payload = self._output_payload(payload, runner_result)
        output_id = self.queue.complete(item.id, output_payload)
        return WorkerResult(item_id=item.id, output_id=output_id, succeeded=True)

    @staticmethod
    def _output_payload(payload: FizzyWorkItemPayload, result: JSONDict) -> JSONDict:
        return {
            "source": payload.source,
            "card_id": payload.card.get("id"),
            "card_number": payload.card.get("number"),
            "comment": result.get("comment", ""),
            "handoff_state": result.get(
                "handoff_state",
                payload.workflow.get("handoff_column", "Synthesize & Verify"),
            ),
            "runner": payload.runner,
            "result": dict(result),
        }


@dataclass
class FizzyWorkItemReporter:
    """Report one completed work item result back to the tracker."""

    queue: WorkItemQueue
    tracker: TrackerAdapter
    failure_code: str = "FIZZY_REPORTER_FAILED"

    def report_one(self) -> ReporterResult:
        item = self.queue.reserve()
        try:
            payload = item.payload
            card_id = str(payload["card_id"])
            card_number = int(payload["card_number"])
            comment = str(payload.get("comment") or "Codex work item completed.")
            handoff_state = str(payload.get("handoff_state") or "Synthesize & Verify")

            self.tracker.create_comment(card_number, comment)
            self.tracker.move_card_to_column(card_number, handoff_state)
            self.queue.complete(item.id, {"reported": True, "card_id": card_id})
        except Exception as exc:
            self.queue.fail(item.id, message=str(exc), code=self.failure_code)
            return ReporterResult(item_id=item.id, reported=False)

        return ReporterResult(item_id=item.id, reported=True)
