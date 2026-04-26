# WorkAI Production Smoke RCC Suite

Manual, gated smoke for the disposable WorkAI fixture path. This suite owns an
RCC environment root and GitHub Actions caller, but it is intentionally
`workflow_dispatch` only until live Fizzy and Codex SDK/app-server credentials
are present.

```bash
WORKAI_SMOKE_BOARD_ID="board_disposable" \
rcc run -r robot_tests/workai_production_smoke/robot.yaml --dev -t WorkAIProductionSmoke --silent
```

Live Fizzy mutation remains opt-in through `WORKAI_SMOKE_LIVE_FIZZY=1` plus the
explicit disposable board/card mapping variables documented in
`docs/production-smoke-agent.md`.
