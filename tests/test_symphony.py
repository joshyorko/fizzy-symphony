from fizzy_symphony.symphony import (
    format_init_board_plan,
    format_mapping_table,
    recommended_columns,
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
        "Done",
    ]


def test_format_init_board_plan_uses_existing_board():
    plan = format_init_board_plan("board-1")

    assert "configure an existing tracker board" in plan
    assert "fizzy column list --board board-1 --agent --quiet" in plan
    assert "fizzy column create --board board-1 --name 'Synthesize & Verify'" in plan


def test_format_mapping_table_explains_upstream_alignment():
    mapping = format_mapping_table()

    assert "Linear issue -> Fizzy card" in mapping
    assert "Orchestrator state -> Robocorp workitem state" in mapping
    assert len(upstream_mapping()) >= 5
