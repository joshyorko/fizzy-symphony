import pytest

from fizzy_symphony.board_contracts import (
    CompletionAction,
    CompletionPolicy,
    DuplicateGoldenTicketError,
)
from fizzy_symphony.board_routing import (
    RoutingDecision,
    discover_routes_by_column,
    route_board_cards,
)


COLUMNS = [
    {"id": "col_ready", "name": "Ready for Agents"},
    {"id": "col_done", "name": "Done"},
    {"id": "col_other", "name": "Other Work"},
]


def _card(number, *, column_id="col_ready", column_name="Ready for Agents", **overrides):
    card = {
        "id": f"card_{number}",
        "number": number,
        "title": f"Card {number}",
        "description": f"Description {number}",
        "golden": False,
        "tags": [],
        "column": {"id": column_id, "name": column_name},
    }
    card.update(overrides)
    return card


def _golden(number=1, **overrides):
    values = {
        "id": f"golden_{number}",
        "title": "Golden instructions",
        "description": "Follow the route.",
        "golden": True,
        "tags": ["agent-instructions", "codex", "move-to-done"],
        "steps": ["Read the card", "Leave proof"],
    }
    values.update(overrides)
    return _card(number, **values)


def test_discovers_routes_by_golden_ticket_column():
    routes = discover_routes_by_column(
        board_id="board_1",
        cards=[_golden(), _card(42)],
        columns=COLUMNS,
    )

    assert list(routes) == ["col_ready"]
    assert routes["col_ready"].card_number == 1
    assert routes["col_ready"].completion_policy == CompletionPolicy(
        action=CompletionAction.MOVE,
        target_column_id="col_done",
        target_column_name="Done",
    )


def test_discovers_routes_from_flat_card_column_shape():
    golden = _golden()
    golden.pop("column")
    golden["column_id"] = "col_ready"
    golden["column_name"] = "Ready for Agents"
    work_card = _card(42)
    work_card.pop("column")
    work_card["column_id"] = "col_ready"
    work_card["column_name"] = "Ready for Agents"

    decisions = route_board_cards(
        board_id="board_1",
        cards=[golden, work_card],
        columns=COLUMNS,
    )

    assert len(decisions) == 1
    assert decisions[0].action == "spawn"
    assert decisions[0].card.number == 42
    assert decisions[0].route.card_number == 1


def test_actual_golden_flag_is_required_for_route_discovery():
    routes = discover_routes_by_column(
        board_id="board_1",
        cards=[_golden(golden=False), _card(42)],
        columns=COLUMNS,
    )

    assert routes == {}


def test_spawn_decisions_include_route_comments_backend_completion_and_dedupe_key():
    decisions = route_board_cards(
        board_id="board_1",
        cards=[_golden(), _card(43), _card(42)],
        columns=COLUMNS,
        comments_by_card={
            42: [{"id": "comment_1", "body": "Please preserve behavior.", "author": "Josh"}],
        },
    )

    assert [decision.card.number for decision in decisions] == [42, 43]
    first = decisions[0]
    assert first.action == "spawn"
    assert first.card.number == 42
    assert first.route.card_number == 1
    assert first.backend == "codex"
    assert first.completion_policy.action == CompletionAction.MOVE
    assert [comment.body for comment in first.comments] == ["Please preserve behavior."]
    assert first.dedupe_key == "board_1:42:col_ready:1"


@pytest.mark.parametrize(
    ("card", "reason"),
    [
        (_golden(number=9, tags=[]), "golden_ticket"),
        (_card(10, closed=True), "closed"),
        (_card(11, state="closed"), "closed"),
        (_card(12, postponed=True), "postponed"),
        (_card(13, tags=["not-now"]), "postponed"),
        (_card(14, column={}), "no_column"),
        (_card(15, column_id="col_other", column_name="Other Work"), "unconfigured_column"),
    ],
)
def test_skips_ineligible_cards(card, reason):
    decisions = route_board_cards(
        board_id="board_1",
        cards=[_golden(), card],
        columns=COLUMNS,
        include_ignored=True,
    )

    ignored = [decision for decision in decisions if decision.card and decision.card.number == card["number"]][0]
    assert ignored == RoutingDecision(action="ignore", card=ignored.card, reason=reason)


def test_respects_active_and_leased_card_numbers():
    decisions = route_board_cards(
        board_id="board_1",
        cards=[_golden(), _card(42), _card(43), _card(44)],
        columns=COLUMNS,
        active_card_numbers={42},
        leased_card_numbers={43},
        include_ignored=True,
    )

    by_number = {decision.card.number: decision for decision in decisions if decision.card}
    assert by_number[42].action == "ignore"
    assert by_number[42].reason == "already_running"
    assert by_number[43].action == "ignore"
    assert by_number[43].reason == "already_leased"
    assert by_number[44].action == "spawn"


def test_normalizes_caller_provided_card_numbers():
    decisions = route_board_cards(
        board_id="board_1",
        cards=[_golden(7), _card(42), _card(43), _card(44)],
        columns=COLUMNS,
        active_card_numbers={"42"},
        leased_card_numbers={"43"},
        changed_card_numbers={"7"},
        include_ignored=True,
    )

    assert decisions[0].action == "refresh_golden_tickets"
    by_number = {decision.card.number: decision for decision in decisions if decision.card}
    assert by_number[42].action == "ignore"
    assert by_number[42].reason == "already_running"
    assert by_number[43].action == "ignore"
    assert by_number[43].reason == "already_leased"
    assert by_number[44].action == "spawn"


def test_active_card_that_became_ineligible_returns_cancel_decision():
    decisions = route_board_cards(
        board_id="board_1",
        cards=[_golden(), _card(42, closed=True)],
        columns=COLUMNS,
        active_card_numbers={42},
    )

    assert decisions == (
        RoutingDecision(
            action="cancel",
            card=decisions[0].card,
            reason="closed",
            dedupe_key="board_1:42:cancel",
        ),
    )


def test_duplicate_golden_error_surfaces_from_contracts():
    with pytest.raises(DuplicateGoldenTicketError, match="Duplicate golden tickets"):
        route_board_cards(
            board_id="board_1",
            cards=[_golden(1), _golden(2)],
            columns=COLUMNS,
        )


def test_changed_golden_ticket_returns_refresh_decision():
    decisions = route_board_cards(
        board_id="board_1",
        cards=[_golden(7), _card(42)],
        columns=COLUMNS,
        changed_card_numbers={7},
    )

    assert decisions[0] == RoutingDecision(
        action="refresh_golden_tickets",
        card=decisions[0].card,
        route=decisions[0].route,
        reason="golden_ticket_changed",
        dedupe_key="board_1:7:refresh_golden_tickets",
    )
    assert decisions[1].action == "spawn"


@pytest.mark.parametrize(
    "changed_card",
    [
        _golden(7, tags=["codex"]),
        _golden(7, golden=False),
    ],
)
def test_changed_deconfigured_golden_ticket_returns_refresh_decision(changed_card):
    decisions = route_board_cards(
        board_id="board_1",
        cards=[changed_card, _card(42)],
        columns=COLUMNS,
        changed_card_numbers={7},
    )

    assert decisions == (
        RoutingDecision(
            action="refresh_golden_tickets",
            card=decisions[0].card,
            reason="golden_ticket_changed",
            dedupe_key="board_1:7:refresh_golden_tickets",
        ),
    )
