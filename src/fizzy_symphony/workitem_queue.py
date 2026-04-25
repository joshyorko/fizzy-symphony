"""Robocorp work item queue integration primitives."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, Protocol

from .models import FizzyCard


JSONDict = Dict[str, Any]


class WorkItemState(str, Enum):
    """Release states compatible with robocorp.workitems adapters."""

    DONE = "COMPLETED"
    FAILED = "FAILED"


class WorkItemAdapter(Protocol):
    """Subset of robocorp.workitems BaseAdapter used by Fizzy Symphony."""

    def reserve_input(self) -> str: ...

    def release_input(
        self,
        item_id: str,
        state: WorkItemState,
        exception: Optional[JSONDict] = None,
    ) -> None: ...

    def create_output(self, parent_id: str, payload: Optional[JSONDict] = None) -> str: ...

    def load_payload(self, item_id: str) -> JSONDict: ...

    def save_payload(self, item_id: str, payload: JSONDict) -> None: ...


@dataclass(frozen=True)
class ReservedWorkItem:
    """Reserved work item payload from an adapter."""

    id: str
    payload: JSONDict


@dataclass(frozen=True)
class FizzyWorkItemPayload:
    """Stable payload contract for turning Fizzy cards into work items."""

    source: str
    card: JSONDict
    workflow: JSONDict
    runner: JSONDict

    @classmethod
    def from_card(
        cls,
        card: FizzyCard,
        *,
        board_id: Optional[str],
        prompt_template: str = "",
        allowed_paths: Optional[List[str]] = None,
        handoff_column: str = "Synthesize & Verify",
        runner_command: str = "codex exec --json",
    ) -> "FizzyWorkItemPayload":
        card_data = asdict(card)
        card_data["board_id"] = board_id
        return cls(
            source="fizzy",
            card=card_data,
            workflow={
                "prompt_template": prompt_template,
                "allowed_paths": list(allowed_paths or []),
                "handoff_column": handoff_column,
            },
            runner={
                "kind": "codex",
                "command": runner_command,
            },
        )

    @classmethod
    def from_dict(cls, payload: JSONDict) -> "FizzyWorkItemPayload":
        source = payload.get("source")
        if source != "fizzy":
            raise ValueError(f"unsupported work item source: {source!r}")
        return cls(
            source=source,
            card=dict(payload.get("card") or {}),
            workflow=dict(payload.get("workflow") or {}),
            runner=dict(payload.get("runner") or {}),
        )

    def to_dict(self) -> JSONDict:
        return {
            "source": self.source,
            "card": dict(self.card),
            "workflow": dict(self.workflow),
            "runner": dict(self.runner),
        }


class WorkItemQueue:
    """Thin wrapper over a Robocorp-compatible work item adapter.

    This keeps durable queue mechanics in the workitems layer while Fizzy
    Symphony owns only the card payload contract and orchestration semantics.
    """

    def __init__(self, adapter: WorkItemAdapter) -> None:
        self.adapter = adapter

    def enqueue_input(self, payload: FizzyWorkItemPayload) -> str:
        seed_input = getattr(self.adapter, "seed_input", None)
        if not callable(seed_input):
            raise RuntimeError(
                "Adapter must provide seed_input(payload=...) to enqueue root Fizzy work items."
            )
        return str(seed_input(payload=payload.to_dict()))

    def reserve(self) -> ReservedWorkItem:
        item_id = self.adapter.reserve_input()
        payload = self.adapter.load_payload(item_id)
        if not isinstance(payload, dict):
            raise ValueError("Work item payload must be a JSON object.")
        return ReservedWorkItem(id=item_id, payload=payload)

    def complete(self, item_id: str, result_payload: JSONDict) -> str:
        output_id = self.adapter.create_output(item_id, payload=result_payload)
        self.adapter.release_input(item_id, WorkItemState.DONE, exception=None)
        return output_id

    def fail(self, item_id: str, *, message: str, code: Optional[str] = None) -> None:
        self.adapter.release_input(
            item_id,
            WorkItemState.FAILED,
            exception={
                "type": "APPLICATION",
                "code": code,
                "message": message,
            },
        )
