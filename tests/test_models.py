"""
Tests for fizzy_symphony.models — covers Agent, CardAdapter, Board, FizzyCard, and FizzyConfig.
"""

import pytest

from fizzy_symphony.models import (
    Agent,
    AgentCapability,
    Board,
    CardAdapter,
    CardStatus,
    FizzyCard,
    FizzyConfig,
)


class TestFizzyCard:
    def test_default_optional_values(self):
        card = FizzyCard(
            id="card_123",
            number=42,
            identifier="work-ai-board-42",
            title="Implement adapter scaffold",
            state="Ready for Agents",
        )
        assert card.description == ""
        assert card.labels == []
        assert card.blocked_by == []
        assert card.column_id is None

    def test_requires_required_fields(self):
        with pytest.raises(ValueError, match="FizzyCard.id"):
            FizzyCard(id="", number=42, identifier="abc", title="x", state="Ready")

        with pytest.raises(ValueError, match="FizzyCard.number"):
            FizzyCard(id="card_123", number=0, identifier="abc", title="x", state="Ready")

        with pytest.raises(ValueError, match="FizzyCard.identifier"):
            FizzyCard(id="card_123", number=42, identifier="", title="x", state="Ready")

        with pytest.raises(ValueError, match="FizzyCard.title"):
            FizzyCard(id="card_123", number=42, identifier="abc", title="", state="Ready")

        with pytest.raises(ValueError, match="FizzyCard.state"):
            FizzyCard(id="card_123", number=42, identifier="abc", title="x", state="")


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


class TestCardAdapter:
    def _make_agent(self) -> Agent:
        return Agent(name="default-agent")

    def test_default_values(self):
        card = CardAdapter(number=1, title="do something", agent=self._make_agent())
        assert card.status == CardStatus.BACKLOG
        assert card.column_id == "backlog"
        assert card.labels == []
        assert card.comment_body is None

    def test_custom_comment_body(self):
        card = CardAdapter(
            number=2,
            title="Write code",
            agent=self._make_agent(),
            comment_body="Implemented the dry-run note for the card.",
        )
        assert card.comment_body == "Implemented the dry-run note for the card."

    def test_card_number_must_be_positive(self):
        with pytest.raises(ValueError, match="number"):
            CardAdapter(number=0, title="x", agent=self._make_agent())

    def test_empty_title_raises(self):
        with pytest.raises(ValueError, match="title"):
            CardAdapter(number=3, title="", agent=self._make_agent())

    def test_empty_column_id_raises(self):
        with pytest.raises(ValueError, match="column_id"):
            CardAdapter(number=4, title="x", column_id="", agent=self._make_agent())

    def test_labels_stored(self):
        card = CardAdapter(
            number=5,
            title="last step",
            agent=self._make_agent(),
            labels=["docs", "tests"],
        )
        assert card.labels == ["docs", "tests"]

    def test_can_convert_to_fizzy_card(self):
        card = CardAdapter(number=5, title="last step", agent=self._make_agent(), column_id="ready")
        normalized = card.as_fizzy_card(card_id="card_5", identifier="work-ai-board-5", state="Ready for Agents")
        assert normalized.id == "card_5"
        assert normalized.number == 5
        assert normalized.column_id == "ready"

    def test_card_status_enum_values(self):
        assert CardStatus.BACKLOG == "backlog"
        assert CardStatus.READY == "ready"
        assert CardStatus.IN_PROGRESS == "in_progress"
        assert CardStatus.DONE == "done"
        assert CardStatus.BLOCKED == "blocked"


class TestBoard:
    def _make_agent(self) -> Agent:
        return Agent(name="board-agent")

    def _make_card(self, number: int) -> CardAdapter:
        return CardAdapter(number=number, title=f"Card {number}", agent=self._make_agent())

    def test_empty_board(self):
        board = Board(name="empty")
        assert board.cards == []
        assert board.card_numbers() == []
        assert board.tracker == "fizzy"

    def test_add_card(self):
        board = Board(name="board-1")
        card = self._make_card(1)
        board.add_card(card)
        assert len(board.cards) == 1
        assert board.card_numbers() == [1]

    def test_card_numbers_order_preserved(self):
        board = Board(name="board-2", cards=[self._make_card(10), self._make_card(11)])
        assert board.card_numbers() == [10, 11]

    def test_get_card_found(self):
        card = self._make_card(42)
        board = Board(name="board-3", cards=[card])
        result = board.get_card(42)
        assert result is card

    def test_get_card_not_found(self):
        board = Board(name="board-4")
        assert board.get_card(999) is None

    def test_empty_name_raises(self):
        with pytest.raises(ValueError, match="Board.name"):
            Board(name="")

    def test_empty_tracker_raises(self):
        with pytest.raises(ValueError, match="Board.tracker"):
            Board(name="board-5", tracker="")

    def test_description_optional(self):
        board = Board(name="board-6")
        assert board.description is None
        board2 = Board(name="board-7", description="A test board")
        assert board2.description == "A test board"


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
            board="board_123",
            dry_run=False,
            extra_flags=["--verbose"],
            timeout_seconds=600,
        )
        assert cfg.fizzy_bin == "/usr/local/bin/fizzy"
        assert cfg.workspace == "/data/ws"
        assert cfg.board == "board_123"
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
