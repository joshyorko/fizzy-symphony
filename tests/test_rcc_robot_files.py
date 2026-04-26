from pathlib import Path

from robots.workitems.tasks import InMemoryWorkItemAdapter, run_smoke_sqlite_workitem_flow


ROOT = Path(__file__).resolve().parents[1]
ROBOT_ROOT = ROOT / "robots" / "workitems"


def test_rcc_workitem_robot_files_exist():
    assert (ROBOT_ROOT / "robot.yaml").is_file()
    assert (ROBOT_ROOT / "conda.yaml").is_file()
    assert (ROBOT_ROOT / "tasks.py").is_file()
    assert (ROBOT_ROOT / "devdata" / "env-sqlite.json").is_file()


def test_robot_yaml_exposes_expected_tasks():
    robot_yaml = (ROBOT_ROOT / "robot.yaml").read_text(encoding="utf-8")

    assert "Doctor:" in robot_yaml
    assert "WorkitemsEnv:" in robot_yaml
    assert "SmokeSQLiteWorkitemFlow:" in robot_yaml
    assert "robocorp.tasks" in robot_yaml


def test_smoke_helper_runs_with_in_memory_adapter(tmp_path):
    adapter = InMemoryWorkItemAdapter()

    proof = run_smoke_sqlite_workitem_flow(
        adapter=adapter,
        output_dir=tmp_path,
        prefer_real_adapter=False,
    )

    assert proof["status"] == "PASS"
    assert proof["adapter"] == "provided"
    assert proof["safe_by_default"] is True
    assert proof["mutated_fizzy"] is False
    assert proof["output_payload"]["card_id"] == "smoke-card-1"
    assert proof["output_payload"]["comment"] == "Smoke runner completed card 1 without mutation."
    assert (tmp_path / "smoke-workitem-flow.json").is_file()
