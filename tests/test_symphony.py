import pytest

from fizzy_symphony.symphony import (
    FizzyCustomColumn,
    fizzy_system_lanes,
    format_init_board_plan,
    format_mapping_table,
    recommended_columns,
    resolve_fizzy_lane,
    upstream_mapping,
)


def test_recommended_columns_follow_symphony_lifecycle():
    names = [column.name for column in recommended_columns()]

    assert names == [
        "Shaping",
        "Ready for Agents",
        "In Flight",
        "Needs Input",
        "Synthesize & Verify",
        "Ready to Ship",
    ]


def test_fizzy_system_lanes_are_immutable_board_lanes():
    lanes = {lane.pseudo_id: lane for lane in fizzy_system_lanes()}

    assert lanes["maybe"].kind == "triage"
    assert lanes["not-now"].kind == "not_now"
    assert lanes["done"].kind == "closed"


def test_resolve_fizzy_lane_maps_system_aliases():
    maybe = resolve_fizzy_lane("triage")
    not_now = resolve_fizzy_lane("not_now")
    done = resolve_fizzy_lane("closed")

    assert maybe.kind == "triage"
    assert maybe.pseudo_id == "maybe"
    assert not_now.kind == "not_now"
    assert not_now.pseudo_id == "not-now"
    assert done.kind == "closed"
    assert done.pseudo_id == "done"


def test_resolve_fizzy_lane_supports_custom_column_ids_and_names():
    columns = [
        FizzyCustomColumn(column_id="col_ready", name="Ready for Agents"),
        FizzyCustomColumn(column_id="col_ship", name="Ready to Ship"),
    ]

    by_id = resolve_fizzy_lane("col_ship", custom_columns=columns)
    by_name = resolve_fizzy_lane("Ready for Agents", custom_columns=columns)

    assert by_id.kind == "custom_column"
    assert by_id.column_id == "col_ship"
    assert by_name.kind == "custom_column"
    assert by_name.column_id == "col_ready"


def test_resolve_fizzy_lane_rejects_duplicate_custom_column_names():
    columns = [
        FizzyCustomColumn(column_id="col_a", name="Ready"),
        FizzyCustomColumn(column_id="col_b", name="Ready"),
    ]

    with pytest.raises(ValueError, match="Duplicate custom column name 'Ready'.*column IDs"):
        resolve_fizzy_lane("Ready", custom_columns=columns)


def test_format_init_board_plan_uses_existing_board():
    plan = format_init_board_plan("board-1")

    assert "configure an existing tracker board" in plan
    assert "Fizzy system lanes already exist" in plan
    assert "- Done (done, closed)" in plan
    assert "fizzy column list --board board-1 --agent --quiet" in plan
    assert "fizzy column create --board board-1 --name 'Synthesize & Verify'" in plan
    assert "fizzy column create --board board-1 --name 'Maybe?'" not in plan
    assert "fizzy column create --board board-1 --name 'Not Now'" not in plan
    assert "fizzy column create --board board-1 --name Done" not in plan


def test_format_mapping_table_explains_upstream_alignment():
    mapping = format_mapping_table()

    assert "Linear issue -> Fizzy card" in mapping
    assert "Orchestrator state -> Robocorp workitem state" in mapping
    assert len(upstream_mapping()) >= 5
