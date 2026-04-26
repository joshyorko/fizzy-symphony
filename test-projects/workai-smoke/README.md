# WorkAI Smoke Project

This directory is a repo-local harness for proving `fizzy-symphony` against a disposable WorkAI/Fizzy board. It is safe by default: `bootstrap_board.py` prints Fizzy CLI commands and does not run them unless `--live` is passed.

The production smoke fixture is intentionally larger than a unit-test toy: it
creates one real golden ticket plus eight task cards so the dashboard can show
queueing, claiming, implementation, verification, and report-back across
several kinds of work.

## Smoke Loop

1. Create and configure a disposable Fizzy board with `python test-projects/workai-smoke/bootstrap_board.py --live --create-board`.
2. Save the returned board id as `WORKAI_SMOKE_BOARD_ID`.
3. Open the board and confirm the golden-ticket card plus the fake task cards exist in the agent column.
4. Run the RCC workitem robot against the disposable board.
5. Run the Codex runner against this fake project directory.
6. Inspect the board for claim, progress, result, and verification updates.
7. Delete the disposable board when finished.

If the board already exists, configure it explicitly:

```bash
python test-projects/workai-smoke/bootstrap_board.py --board-id "$WORKAI_SMOKE_BOARD_ID" --live
```

For a preview only:

```bash
python test-projects/workai-smoke/bootstrap_board.py
```

The fixture lives in `board.fixture.json`. It intentionally uses generic board/card content and does not include Josh's live board IDs.

The full production smoke agent is specified in
`docs/production-smoke-agent.md`. It must use the Codex SDK runner, not only the
CLI fallback.
