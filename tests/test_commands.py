"""
Tests for fizzy_symphony.commands — covers build_agent_command,
build_workflow_plan, and format_plan_as_text.
"""

import pytest

from fizzy_symphony.commands import (
    build_agent_command,
    build_workflow_plan,
    format_plan_as_text,
)
from fizzy_symphony.models import Agent, FizzyConfig, Task, Workflow


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_agent(**kwargs) -> Agent:
    defaults = dict(name="test-agent", model="gpt-4o", max_tokens=4096, temperature=0.2)
    defaults.update(kwargs)
    return Agent(**defaults)


def _make_task(task_id="task-1", description="Do something", **kwargs) -> Task:
    agent = kwargs.pop("agent", _make_agent())
    return Task(task_id=task_id, description=description, agent=agent, **kwargs)


def _make_config(**kwargs) -> FizzyConfig:
    defaults = dict(fizzy_bin="fizzy", workspace="/tmp/ws", dry_run=True, timeout_seconds=300)
    defaults.update(kwargs)
    return FizzyConfig(**defaults)


# ---------------------------------------------------------------------------
# build_agent_command tests
# ---------------------------------------------------------------------------

class TestBuildAgentCommand:
    def test_contains_fizzy_bin(self):
        cmd = build_agent_command(_make_agent(), _make_task(), _make_config(fizzy_bin="fizzy"))
        assert cmd.startswith("fizzy run")

    def test_contains_model(self):
        cmd = build_agent_command(_make_agent(model="gpt-3.5-turbo"), _make_task(), _make_config())
        assert "--model gpt-3.5-turbo" in cmd

    def test_contains_max_tokens(self):
        cmd = build_agent_command(_make_agent(max_tokens=2048), _make_task(), _make_config())
        assert "--max-tokens 2048" in cmd

    def test_contains_temperature(self):
        cmd = build_agent_command(_make_agent(temperature=0.7), _make_task(), _make_config())
        assert "--temperature 0.7" in cmd

    def test_contains_workspace(self):
        cmd = build_agent_command(_make_agent(), _make_task(), _make_config(workspace="/data/ws"))
        assert "--workspace /data/ws" in cmd

    def test_contains_timeout(self):
        cmd = build_agent_command(_make_agent(), _make_task(), _make_config(timeout_seconds=600))
        assert "--timeout 600" in cmd

    def test_contains_task_id(self):
        cmd = build_agent_command(_make_agent(), _make_task(task_id="my-task"), _make_config())
        assert "--task-id my-task" in cmd

    def test_uses_prompt_when_provided(self):
        task = _make_task(prompt="Write a binary search.")
        cmd = build_agent_command(_make_agent(), task, _make_config())
        assert "Write a binary search." in cmd

    def test_falls_back_to_description_when_no_prompt(self):
        task = _make_task(description="Describe the function.", prompt=None)
        cmd = build_agent_command(_make_agent(), task, _make_config())
        assert "Describe the function." in cmd

    def test_dry_run_flag_present_when_true(self):
        cmd = build_agent_command(_make_agent(), _make_task(), _make_config(dry_run=True))
        assert "--dry-run" in cmd

    def test_dry_run_flag_absent_when_false(self):
        cmd = build_agent_command(_make_agent(), _make_task(), _make_config(dry_run=False))
        assert "--dry-run" not in cmd

    def test_extra_flags_appended(self):
        cfg = _make_config(extra_flags=["--verbose", "--log-level=debug"])
        cmd = build_agent_command(_make_agent(), _make_task(), cfg)
        assert "--verbose" in cmd
        assert "--log-level=debug" in cmd

    def test_custom_fizzy_bin_path(self):
        cfg = _make_config(fizzy_bin="/usr/local/bin/fizzy")
        cmd = build_agent_command(_make_agent(), _make_task(), cfg)
        assert cmd.startswith("/usr/local/bin/fizzy run")

    def test_returns_string(self):
        cmd = build_agent_command(_make_agent(), _make_task(), _make_config())
        assert isinstance(cmd, str)

    def test_no_newlines_in_command(self):
        cmd = build_agent_command(_make_agent(), _make_task(), _make_config())
        assert "\n" not in cmd


# ---------------------------------------------------------------------------
# build_workflow_plan tests
# ---------------------------------------------------------------------------

class TestBuildWorkflowPlan:
    def _make_workflow(self) -> Workflow:
        agent = _make_agent()
        t1 = _make_task(task_id="step-1", description="First step")
        t2 = _make_task(task_id="step-2", description="Second step", depends_on=["step-1"])
        return Workflow(name="test-wf", tasks=[t1, t2])

    def test_plan_length_matches_tasks(self):
        wf = self._make_workflow()
        plan = build_workflow_plan(wf, _make_config())
        assert len(plan) == 2

    def test_plan_entry_keys(self):
        wf = self._make_workflow()
        plan = build_workflow_plan(wf, _make_config())
        for entry in plan:
            assert "task_id" in entry
            assert "description" in entry
            assert "agent" in entry
            assert "command" in entry
            assert "depends_on" in entry

    def test_task_ids_in_order(self):
        wf = self._make_workflow()
        plan = build_workflow_plan(wf, _make_config())
        assert plan[0]["task_id"] == "step-1"
        assert plan[1]["task_id"] == "step-2"

    def test_depends_on_empty_for_first_task(self):
        wf = self._make_workflow()
        plan = build_workflow_plan(wf, _make_config())
        assert plan[0]["depends_on"] == ""

    def test_depends_on_populated_for_second_task(self):
        wf = self._make_workflow()
        plan = build_workflow_plan(wf, _make_config())
        assert "step-1" in plan[1]["depends_on"]

    def test_agent_name_in_plan_entry(self):
        wf = self._make_workflow()
        plan = build_workflow_plan(wf, _make_config())
        assert plan[0]["agent"] == "test-agent"

    def test_command_is_string(self):
        wf = self._make_workflow()
        plan = build_workflow_plan(wf, _make_config())
        for entry in plan:
            assert isinstance(entry["command"], str)
            assert len(entry["command"]) > 0

    def test_empty_workflow_returns_empty_plan(self):
        wf = Workflow(name="empty-wf")
        plan = build_workflow_plan(wf, _make_config())
        assert plan == []

    def test_multiple_depends_on_joined_with_comma(self):
        agent = _make_agent()
        t = _make_task(task_id="final", description="Final", depends_on=["a", "b", "c"])
        wf = Workflow(name="multi-dep", tasks=[t])
        plan = build_workflow_plan(wf, _make_config())
        assert plan[0]["depends_on"] == "a, b, c"


# ---------------------------------------------------------------------------
# format_plan_as_text tests
# ---------------------------------------------------------------------------

class TestFormatPlanAsText:
    def _plan(self) -> list:
        wf = Workflow(
            name="fmt-wf",
            tasks=[
                _make_task(task_id="alpha", description="Alpha task"),
                _make_task(task_id="beta", description="Beta task", depends_on=["alpha"]),
            ],
        )
        return build_workflow_plan(wf, _make_config())

    def test_returns_string(self):
        plan = self._plan()
        text = format_plan_as_text(plan)
        assert isinstance(text, str)

    def test_contains_header(self):
        text = format_plan_as_text(self._plan())
        assert "Fizzy Symphony" in text

    def test_contains_task_ids(self):
        text = format_plan_as_text(self._plan())
        assert "alpha" in text
        assert "beta" in text

    def test_contains_step_numbers(self):
        text = format_plan_as_text(self._plan())
        assert "Step 1" in text
        assert "Step 2" in text

    def test_empty_plan_returns_empty_message(self):
        text = format_plan_as_text([])
        assert "empty" in text.lower()

    def test_depends_on_shown_when_present(self):
        text = format_plan_as_text(self._plan())
        assert "alpha" in text  # beta depends on alpha

    def test_command_present_in_output(self):
        text = format_plan_as_text(self._plan())
        assert "fizzy run" in text
