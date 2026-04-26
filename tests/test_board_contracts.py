import pytest

from fizzy_symphony.board_contracts import (
    ActiveRunSummary,
    CompletionAction,
    CompletionPolicy,
    DuplicateGoldenTicketError,
    GoldenTicketRoute,
    NormalizedCard,
    NormalizedComment,
    ReporterResult,
    build_routes_by_column,
    normalize_card,
    normalize_comment,
    normalize_steps,
    normalize_tags,
    parse_golden_ticket_route,
)


COLUMNS = [
    {"id": "col_ready", "name": "Ready for Agents"},
    {"id": "col_verify", "name": "Synthesize & Verify"},
    {"id": "col_ship", "name": "Ready To Ship"},
]


def _golden_card(**overrides):
    card = {
        "id": "card_gt",
        "number": 12,
        "title": "Column agent instructions",
        "description": "Work each card and leave proof.",
        "golden": True,
        "tags": [
            "#agent-instructions",
            {"name": "OpenAI"},
            {"label": "move-to-ready-to-ship"},
        ],
        "column": {"id": "col_ready", "name": "Ready for Agents"},
        "steps": [
            "Read the issue",
            {"content": "Run focused tests"},
            {"title": "Summarize verification"},
        ],
    }
    card.update(overrides)
    return card


def test_normalizes_tags_from_strings_and_dicts():
    tags = normalize_tags(
        [
            " #Agent-Instructions ",
            {"name": "#Codex"},
            {"title": " close-on-complete "},
            {"label": "#move-to-ready-to-ship"},
            {"ignored": "missing known key"},
            "",
        ]
    )

    assert tags == [
        "agent-instructions",
        "codex",
        "close-on-complete",
        "move-to-ready-to-ship",
    ]


def test_normalizes_steps_from_strings_and_known_dict_fields():
    steps = normalize_steps(
        [
            "First",
            {"content": "Second"},
            {"title": "Third"},
            {"name": "Fourth"},
            {"ignored": "skip me"},
            "",
        ]
    )

    assert steps == ["First", "Second", "Third", "Fourth"]


def test_normalizes_cards_and_comments_from_cli_json_shapes():
    card = normalize_card(_golden_card())
    comment = normalize_comment(
        {
            "id": "comment_1",
            "body": "Done",
            "author": {"name": "Josh"},
            "createdAt": "2026-04-26T12:00:00Z",
        }
    )

    assert card == NormalizedCard(
        id="card_gt",
        number=12,
        title="Column agent instructions",
        description="Work each card and leave proof.",
        tags=("agent-instructions", "openai", "move-to-ready-to-ship"),
        steps=("Read the issue", "Run focused tests", "Summarize verification"),
        column_id="col_ready",
        column_name="Ready for Agents",
        golden=True,
        raw=_golden_card(),
    )
    assert comment == NormalizedComment(
        id="comment_1",
        body="Done",
        author="Josh",
        created_at="2026-04-26T12:00:00Z",
        raw={
            "id": "comment_1",
            "body": "Done",
            "author": {"name": "Josh"},
            "createdAt": "2026-04-26T12:00:00Z",
        },
    )


def test_golden_ticket_route_requires_golden_true_and_agent_instruction_tag():
    assert parse_golden_ticket_route(
        _golden_card(golden=False),
        board_id="board_1",
        columns=COLUMNS,
    ) is None
    assert parse_golden_ticket_route(
        _golden_card(tags=["codex"]),
        board_id="board_1",
        columns=COLUMNS,
    ) is None


def test_parse_golden_ticket_route_maps_backend_steps_and_move_policy():
    route = parse_golden_ticket_route(
        _golden_card(),
        board_id="board_1",
        columns=COLUMNS,
        default_backend="codex",
    )

    assert route == GoldenTicketRoute(
        board_id="board_1",
        column_id="col_ready",
        column_name="Ready for Agents",
        card_number=12,
        card_title="Column agent instructions",
        card_description="Work each card and leave proof.",
        card_tags=("agent-instructions", "openai", "move-to-ready-to-ship"),
        steps=("Read the issue", "Run focused tests", "Summarize verification"),
        backend="openai",
        completion_policy=CompletionPolicy(
            action=CompletionAction.MOVE,
            target_column_id="col_ship",
            target_column_name="Ready To Ship",
        ),
    )


@pytest.mark.parametrize("backend", ["codex", "claude", "opencode", "anthropic", "openai", "command"])
def test_backend_tag_detection_supports_known_backends(backend):
    route = parse_golden_ticket_route(
        _golden_card(tags=["agent-instructions", backend]),
        board_id="board_1",
        columns=COLUMNS,
        default_backend="codex",
    )

    assert route is not None
    assert route.backend == backend


def test_backend_defaults_to_passed_value_or_codex():
    assert parse_golden_ticket_route(
        _golden_card(tags=["agent-instructions"]),
        board_id="board_1",
        columns=COLUMNS,
        default_backend="claude",
    ).backend == "claude"
    assert parse_golden_ticket_route(
        _golden_card(tags=["agent-instructions"]),
        board_id="board_1",
        columns=COLUMNS,
    ).backend == "codex"


def test_completion_tags_default_to_comment_or_close():
    comment_route = parse_golden_ticket_route(
        _golden_card(tags=["agent-instructions", "codex"]),
        board_id="board_1",
        columns=COLUMNS,
    )
    close_route = parse_golden_ticket_route(
        _golden_card(tags=["agent-instructions", "close-on-complete"]),
        board_id="board_1",
        columns=COLUMNS,
    )

    assert comment_route.completion_policy == CompletionPolicy(action=CompletionAction.COMMENT)
    assert close_route.completion_policy == CompletionPolicy(action=CompletionAction.CLOSE)


def test_move_completion_lookup_is_case_and_slug_insensitive():
    route = parse_golden_ticket_route(
        _golden_card(tags=["agent-instructions", "move-to-synthesize-verify"]),
        board_id="board_1",
        columns=COLUMNS,
    )

    assert route.completion_policy == CompletionPolicy(
        action=CompletionAction.MOVE,
        target_column_id="col_verify",
        target_column_name="Synthesize & Verify",
    )


def test_move_completion_lookup_treats_and_like_ampersand():
    route = parse_golden_ticket_route(
        _golden_card(tags=["agent-instructions", "move-to-synthesize-and-verify"]),
        board_id="board_1",
        columns=COLUMNS,
    )

    assert route.completion_policy == CompletionPolicy(
        action=CompletionAction.MOVE,
        target_column_id="col_verify",
        target_column_name="Synthesize & Verify",
    )


def test_golden_ticket_route_rejects_missing_column_id():
    with pytest.raises(ValueError, match="Golden ticket card 12 missing column id"):
        parse_golden_ticket_route(
            _golden_card(column={"name": "Ready for Agents"}),
            board_id="board_1",
            columns=COLUMNS,
        )


def test_golden_ticket_route_rejects_missing_column_name():
    with pytest.raises(ValueError, match="Golden ticket card 12 missing column name"):
        parse_golden_ticket_route(
            _golden_card(column={"id": "col_ready"}),
            board_id="board_1",
            columns=COLUMNS,
        )


def test_parsed_contract_sequences_are_immutable():
    card = normalize_card(_golden_card())
    route = parse_golden_ticket_route(
        _golden_card(),
        board_id="board_1",
        columns=COLUMNS,
    )

    assert card.tags == ("agent-instructions", "openai", "move-to-ready-to-ship")
    assert card.steps == ("Read the issue", "Run focused tests", "Summarize verification")
    assert route.card_tags == ("agent-instructions", "openai", "move-to-ready-to-ship")
    assert route.steps == ("Read the issue", "Run focused tests", "Summarize verification")
    with pytest.raises(AttributeError):
        card.tags.append("later")
    with pytest.raises(AttributeError):
        route.steps.append("later")


def test_duplicate_golden_tickets_for_same_column_raise_clear_error():
    duplicate = _golden_card(id="card_other", number=13, title="Other instructions")

    with pytest.raises(DuplicateGoldenTicketError, match="col_ready"):
        build_routes_by_column(
            [_golden_card(), duplicate],
            board_id="board_1",
            columns=COLUMNS,
        )


def test_build_routes_by_column_skips_non_golden_cards():
    routes = build_routes_by_column(
        [_golden_card(), _golden_card(id="normal", number=99, golden=False)],
        board_id="board_1",
        columns=COLUMNS,
    )

    assert list(routes) == ["col_ready"]
    assert routes["col_ready"].card_number == 12


def test_active_run_summary_and_reporter_result_are_lightweight_structures():
    run = ActiveRunSummary(
        card_number=12,
        backend="codex",
        status="completed",
        summary="Tests passed",
    )
    result = ReporterResult(
        card_number=12,
        success=True,
        message="commented",
        completion_policy=CompletionPolicy(action=CompletionAction.COMMENT),
    )

    assert run.status == "completed"
    assert result.success is True
