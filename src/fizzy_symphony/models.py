"""
Data models for Fizzy Symphony.

These dataclasses describe the core domain objects:
  - Agent       : a Codex coding agent with an identity and optional capabilities.
  - Task        : a unit of work assigned to an agent.
  - Workflow    : an ordered collection of tasks forming an orchestration plan.
  - FizzyConfig : runtime configuration used when building Fizzy commands.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional


class TaskStatus(str, Enum):
    """Lifecycle states for a Task."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"


class AgentCapability(str, Enum):
    """Broad capability categories an Agent may advertise."""

    CODE_GENERATION = "code_generation"
    CODE_REVIEW = "code_review"
    TESTING = "testing"
    DOCUMENTATION = "documentation"
    REFACTORING = "refactoring"


@dataclass
class Agent:
    """Represents a Codex coding agent.

    Attributes:
        name: Human-readable identifier for the agent.
        model: The underlying Codex/LLM model tag (e.g. ``"gpt-4o"``).
        capabilities: Optional list of :class:`AgentCapability` values.
        max_tokens: Upper bound on tokens the agent may produce per turn.
        temperature: Sampling temperature in ``[0.0, 2.0]``.
    """

    name: str
    model: str = "gpt-4o"
    capabilities: List[AgentCapability] = field(default_factory=list)
    max_tokens: int = 4096
    temperature: float = 0.2

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("Agent.name must not be empty.")
        if not (0.0 <= self.temperature <= 2.0):
            raise ValueError(
                f"Agent.temperature must be in [0.0, 2.0]; got {self.temperature}."
            )
        if self.max_tokens < 1:
            raise ValueError(
                f"Agent.max_tokens must be >= 1; got {self.max_tokens}."
            )


@dataclass
class Task:
    """A unit of work assigned to an Agent.

    Attributes:
        task_id: Unique identifier for the task within a workflow.
        description: Human-readable description of what the task should do.
        agent: The :class:`Agent` responsible for executing the task.
        depends_on: IDs of tasks that must complete before this one starts.
        status: Current lifecycle status of the task.
        prompt: Optional detailed prompt to pass to the agent.
    """

    task_id: str
    description: str
    agent: Agent
    depends_on: List[str] = field(default_factory=list)
    status: TaskStatus = TaskStatus.PENDING
    prompt: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.task_id:
            raise ValueError("Task.task_id must not be empty.")
        if not self.description:
            raise ValueError("Task.description must not be empty.")


@dataclass
class Workflow:
    """An ordered collection of tasks forming an orchestration plan.

    Attributes:
        name: Human-readable name for the workflow.
        tasks: Ordered list of :class:`Task` objects.
        description: Optional longer description of the workflow's purpose.
    """

    name: str
    tasks: List[Task] = field(default_factory=list)
    description: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("Workflow.name must not be empty.")

    def add_task(self, task: Task) -> None:
        """Append a task to the workflow."""
        self.tasks.append(task)

    def task_ids(self) -> List[str]:
        """Return an ordered list of task IDs in this workflow."""
        return [t.task_id for t in self.tasks]

    def get_task(self, task_id: str) -> Optional[Task]:
        """Look up a task by ID; returns ``None`` if not found."""
        for task in self.tasks:
            if task.task_id == task_id:
                return task
        return None


@dataclass
class FizzyConfig:
    """Runtime configuration used when constructing Fizzy commands.

    Attributes:
        fizzy_bin: Path or name of the ``fizzy`` executable.
        workspace: Working directory for Fizzy job execution.
        dry_run: When ``True``, commands are printed but never executed.
        extra_flags: Additional flags forwarded verbatim to Fizzy.
        timeout_seconds: Per-task execution timeout in seconds.
    """

    fizzy_bin: str = "fizzy"
    workspace: str = "/tmp/fizzy-workspace"
    dry_run: bool = True
    extra_flags: List[str] = field(default_factory=list)
    timeout_seconds: int = 300

    def __post_init__(self) -> None:
        if not self.fizzy_bin:
            raise ValueError("FizzyConfig.fizzy_bin must not be empty.")
        if self.timeout_seconds < 1:
            raise ValueError(
                f"FizzyConfig.timeout_seconds must be >= 1; got {self.timeout_seconds}."
            )
