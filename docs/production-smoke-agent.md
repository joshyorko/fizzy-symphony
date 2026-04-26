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
2. Confirm the golden ticket is actually golden via `fizzy card show`.
3. Discover golden-ticket instructions from the board.
4. Enqueue eligible task cards into SQLite workitems.
5. Reserve one task at a time through RCC.
6. Run Codex through the SDK runner in the sample project workspace.
7. Create real sample-project artifacts: source changes, docs, and tests.
8. Run the sample project test suite.
9. Emit workitem result metadata including SDK thread/run identity.
10. Report proof back to the matching Fizzy card.
11. Move completed cards according to the golden-ticket completion policy.
12. Produce a final smoke summary with board URL, card numbers, artifacts, SDK
    metadata, RCC output path, and test output.

## Non-Goals

- Do not validate production readiness with `CodexCliRunner` alone.
- Do not run against Josh's normal working board.
- Do not hide state outside Fizzy and SQLite workitems.
- Do not mutate live Fizzy unless the operator explicitly requested a live
  disposable board.
