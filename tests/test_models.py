"""
Tests for fizzy_symphony.models — covers Agent, Task, Workflow, and FizzyConfig.
"""

import pytest

from fizzy_symphony.models import (
    Agent,
    AgentCapability,
    FizzyConfig,
    Task,
    TaskStatus,
    Workflow,
)


# ---------------------------------------------------------------------------
# Agent tests
# ---------------------------------------------------------------------------

class TestAgent:
    def test_default_values(self):
        agent = Agent(name="test-agent")
        assert agent.model == "gpt-4o"
        assert agent.max_tokens == 4096
        assert agent.temperature == 0.2
        assert agent.capabilities == []

    def test_custom_values(self):
        agent = Agent(
            name="custom-agent",
            model="gpt-3.5-turbo",
            max_tokens=2048,
            temperature=0.7,
            capabilities=[AgentCapability.CODE_GENERATION, AgentCapability.TESTING],
        )
        assert agent.name == "custom-agent"
        assert agent.model == "gpt-3.5-turbo"
        assert agent.max_tokens == 2048
        assert agent.temperature == 0.7
        assert AgentCapability.CODE_GENERATION in agent.capabilities
        assert AgentCapability.TESTING in agent.capabilities

    def test_empty_name_raises(self):
        with pytest.raises(ValueError, match="Agent.name must not be empty"):
            Agent(name="")

    def test_temperature_below_zero_raises(self):
        with pytest.raises(ValueError, match="temperature"):
            Agent(name="a", temperature=-0.1)

    def test_temperature_above_two_raises(self):
        with pytest.raises(ValueError, match="temperature"):
            Agent(name="a", temperature=2.1)

    def test_temperature_boundary_values_accepted(self):
        Agent(name="a", temperature=0.0)
        Agent(name="b", temperature=2.0)

    def test_max_tokens_zero_raises(self):
        with pytest.raises(ValueError, match="max_tokens"):
            Agent(name="a", max_tokens=0)

    def test_max_tokens_positive_accepted(self):
        agent = Agent(name="a", max_tokens=1)
        assert agent.max_tokens == 1


# ---------------------------------------------------------------------------
# Task tests
# ---------------------------------------------------------------------------

class TestTask:
    def _make_agent(self) -> Agent:
        return Agent(name="default-agent")

    def test_default_values(self):
        task = Task(task_id="t1", description="do something", agent=self._make_agent())
        assert task.status == TaskStatus.PENDING
        assert task.depends_on == []
        assert task.prompt is None

    def test_custom_prompt(self):
        task = Task(
            task_id="t2",
            description="Write code",
            agent=self._make_agent(),
            prompt="Implement a binary search function in Python.",
        )
        assert task.prompt == "Implement a binary search function in Python."

    def test_empty_task_id_raises(self):
        with pytest.raises(ValueError, match="task_id"):
            Task(task_id="", description="x", agent=self._make_agent())

    def test_empty_description_raises(self):
        with pytest.raises(ValueError, match="description"):
            Task(task_id="t3", description="", agent=self._make_agent())

    def test_depends_on_stored(self):
        task = Task(
            task_id="t4",
            description="last step",
            agent=self._make_agent(),
            depends_on=["t1", "t2"],
        )
        assert task.depends_on == ["t1", "t2"]

    def test_task_status_enum_values(self):
        assert TaskStatus.PENDING == "pending"
        assert TaskStatus.RUNNING == "running"
        assert TaskStatus.SUCCEEDED == "succeeded"
        assert TaskStatus.FAILED == "failed"
        assert TaskStatus.SKIPPED == "skipped"


# ---------------------------------------------------------------------------
# Workflow tests
# ---------------------------------------------------------------------------

class TestWorkflow:
    def _make_agent(self) -> Agent:
        return Agent(name="wf-agent")

    def _make_task(self, task_id: str) -> Task:
        return Task(task_id=task_id, description=f"Task {task_id}", agent=self._make_agent())

    def test_empty_workflow(self):
        wf = Workflow(name="empty")
        assert wf.tasks == []
        assert wf.task_ids() == []

    def test_add_task(self):
        wf = Workflow(name="wf1")
        t = self._make_task("a")
        wf.add_task(t)
        assert len(wf.tasks) == 1
        assert wf.task_ids() == ["a"]

    def test_task_ids_order_preserved(self):
        wf = Workflow(name="wf2", tasks=[self._make_task("x"), self._make_task("y")])
        assert wf.task_ids() == ["x", "y"]

    def test_get_task_found(self):
        t = self._make_task("found")
        wf = Workflow(name="wf3", tasks=[t])
        result = wf.get_task("found")
        assert result is t

    def test_get_task_not_found(self):
        wf = Workflow(name="wf4")
        assert wf.get_task("missing") is None

    def test_empty_name_raises(self):
        with pytest.raises(ValueError, match="Workflow.name"):
            Workflow(name="")

    def test_description_optional(self):
        wf = Workflow(name="wf5")
        assert wf.description is None
        wf2 = Workflow(name="wf6", description="A test workflow")
        assert wf2.description == "A test workflow"


# ---------------------------------------------------------------------------
# FizzyConfig tests
# ---------------------------------------------------------------------------

class TestFizzyConfig:
    def test_default_values(self):
        cfg = FizzyConfig()
        assert cfg.fizzy_bin == "fizzy"
        assert cfg.workspace == "/tmp/fizzy-workspace"
        assert cfg.dry_run is True
        assert cfg.extra_flags == []
        assert cfg.timeout_seconds == 300

    def test_custom_values(self):
        cfg = FizzyConfig(
            fizzy_bin="/usr/local/bin/fizzy",
            workspace="/data/ws",
            dry_run=False,
            extra_flags=["--verbose"],
            timeout_seconds=600,
        )
        assert cfg.fizzy_bin == "/usr/local/bin/fizzy"
        assert cfg.workspace == "/data/ws"
        assert cfg.dry_run is False
        assert cfg.extra_flags == ["--verbose"]
        assert cfg.timeout_seconds == 600

    def test_empty_fizzy_bin_raises(self):
        with pytest.raises(ValueError, match="fizzy_bin"):
            FizzyConfig(fizzy_bin="")

    def test_timeout_zero_raises(self):
        with pytest.raises(ValueError, match="timeout_seconds"):
            FizzyConfig(timeout_seconds=0)

    def test_timeout_one_accepted(self):
        cfg = FizzyConfig(timeout_seconds=1)
        assert cfg.timeout_seconds == 1
