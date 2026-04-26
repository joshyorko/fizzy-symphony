# Production Smoke Agent

This is the release gate for proving `fizzy-symphony` works as an application,
not just as a set of unit-tested helpers.

## Goal

Run a realistic sample project from Fizzy cards through RCC workitems, Codex SDK
execution, artifact creation, validation, and Fizzy report-back.

The smoke agent must not treat CLI fallback as sufficient SDK validation. If the
SDK runner is still a placeholder or unavailable, the full smoke must stop
before creating work.

## Readiness Gate

Before the full smoke starts, the agent must prove:

- `CodexSdkRunner` is implemented and selected.
- The SDK runner can start a local Codex session in the sample project workspace.
- The runner returns final response text, thread/run metadata, success state,
  and raw debugging metadata.
- RCC can run the workitem robot with the SQLite adapter.
- Fizzy auth passes `fizzy doctor`.
- A disposable Fizzy board exists with a real golden ticket, not only tags.

The smoke refuses to treat `CodexCliRunner` as SDK proof. If the SDK runner is
missing, returns no thread/run identity, or reports CLI fallback metadata, the
full smoke stops before queueing work.

If any item fails, the smoke is blocked and should report the missing gate.

## Test Project

Use `test-projects/workai-smoke/`.

The fixture creates a disposable dashboard with:

- one real golden-ticket card tagged `agent-instructions`, `codex`, and
  `move-to-synthesize-and-verify`;
- eight task cards that cover code, CLI behavior, docs, tests, and reporting;
- custom workflow columns only, with `Maybe?`, `Not Now`, and `Done` treated as
  Fizzy system lanes.

The fake project is intentionally small so visual board movement and tool
coordination are the thing under test.

## Required Smoke Flow

1. Create or reuse a disposable Fizzy board from the WorkAI fixture.
2. Mark the instruction card with `fizzy card golden <number>`.
3. Confirm the golden ticket is actually golden via `fizzy card show`.
4. Keep the cleanup command explicit: `fizzy board delete <board id>`.
5. Discover golden-ticket instructions from the board.
6. Enqueue eligible task cards into SQLite workitems.
7. Reserve one task at a time through RCC.
8. Run Codex through the SDK runner in the sample project workspace.
9. Create real sample-project artifacts: source changes, docs, and tests.
10. Run the sample project test suite.
11. Emit workitem result metadata including SDK thread/run identity.
12. Report proof back to the matching Fizzy card.
13. Move completed cards according to the golden-ticket completion policy.
14. Produce a final smoke summary with board URL, card numbers, artifacts, SDK
    metadata, RCC output path, and test output.

## Disposable Board Commands

Preview the setup without mutating Fizzy:

```bash
python test-projects/workai-smoke/bootstrap_board.py
```

Create a new disposable board and print the created card numbers:

```bash
python test-projects/workai-smoke/bootstrap_board.py --live --create-board
```

Reuse an existing disposable board:

```bash
python test-projects/workai-smoke/bootstrap_board.py --live --board-id <board id>
```

The bootstrap summary includes `cleanup_command`; run it only for the disposable
smoke board after preserving any evidence Josh wants to inspect.

## RCC Entry Point

The production smoke robot is intentionally guarded:

```bash
WORKAI_SMOKE_BOARD_ID=<disposable board id> \
  rcc run -r robots/workitems/robot.yaml --dev -t WorkAIProductionSmoke
```

Set `WORKAI_SMOKE_LIVE_FIZZY=1` only when report-back comments and column moves
should be posted to the disposable board. Live mode also requires
`WORKAI_SMOKE_HANDOFF_COLUMN_ID=<Synthesize & Verify column id>` so the move
targets a real custom column ID, `WORKAI_SMOKE_GOLDEN_CARD_NUMBER=<number>` so
the harness verifies the actual golden ticket, and
`WORKAI_SMOKE_CARD_NUMBERS=1=<live>,2=<live>,...` so fixture cards are mapped to
the real disposable-board cards before any report-back happens. The robot uses
`WORKAI_SMOKE_CODEX_MODEL=gpt-5.4-mini` and
`WORKAI_SMOKE_CODEX_APPROVAL_POLICY=never` by default; override those only when
you intentionally want a different Codex runtime profile.

Without those variables, the harness creates local workitem/test artifacts and
emits the Fizzy commands it would run.

## Non-Goals

- Do not validate production readiness with `CodexCliRunner` alone.
- Do not run against Josh's normal working board.
- Do not hide state outside Fizzy and SQLite workitems.
- Do not mutate live Fizzy unless the operator explicitly requested a live
  disposable board.
