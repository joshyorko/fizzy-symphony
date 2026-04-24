"""Example board scaffold for Fizzy Symphony."""

from fizzy_symphony import Agent, Board, CardAdapter, FizzyConfig, build_board_plan
from fizzy_symphony.commands import format_plan_as_text

agent = Agent(name="board-agent", model="gpt-4o")

board = Board(
    name="release-readiness",
    tracker="agent-skills/fizzy",
    board_id="03release",
    description="Example board showing how Fizzy mirrors the CLI-backed card adapter contract.",
    cards=[
        CardAdapter(
            number=42,
            title="Review the open bug report and summarize the expected fix.",
            column_id="triage",
            labels=["bug", "priority-high"],
            agent=agent,
            comment_body="Captured the bug summary and proposed the next action in dry-run mode.",
        ),
        CardAdapter(
            number=57,
            title="Update release notes and onboarding docs for the fix.",
            column_id="col_docs",
            labels=["docs"],
            agent=agent,
            comment_body="Draft the release note copy and the docs changes needed for the card.",
        ),
    ],
)

config = FizzyConfig(dry_run=True)

plan = build_board_plan(board, config)
print(format_plan_as_text(plan))
