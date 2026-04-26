# Roadmap

## Executive Status

`fizzy-symphony` is currently a pre-alpha, locally exercised orchestration
prototype. The safest status summary is:

| Area | Status | Notes |
| --- | --- | --- |
| Core models, dry-run Fizzy commands, golden-ticket parsing, workitem queue seam, producer/worker/reporter flow | Implemented | Unit-tested Python paths exist. External tracker mutation remains guarded. |
| SQLite workitem smoke helper and WorkAI sample fixture | Tested locally | Tests exercise the flow with in-memory or local adapters and scripted runners. |
| uv workflow | Hosted proof passing | GitHub Actions has proven the uv install/test path. |
| Python OS/version matrix | Red until fixed | Keep the matrix visible; do not treat it as passing proof yet. |
| Automatic RCC Robot suites | Hosted proof passing | Env resolve, SQLite workitem, Fizzy contract, and Fizzy parity suites have hosted proof. |
| Manual/gated RCC smokes | Workflow dispatch only | Prompt-card and WorkAI production smokes require explicit operator inputs and are not automatic PR CI. |
| Prototype reconciler/status helpers | Implemented | One-shot/watch reconciliation and JSON status snapshots exist for local proof. |
| Live Fizzy smoke | Live smoke gated | Live board/card mutation requires explicit env, real card mapping, and operator cleanup. |
| Production daemon / polling service | Pending | Hardened long-running scheduling, daemon supervision, and orphan recovery remain pending. |
| Webhook receiver | Not implemented | Webhooks remain a later accelerator after polling/reconciliation exists. |

## Phases

- [x] Phase 0: spec/scaffold
- [x] Phase 0.5: Robocorp workitems queue seam
- [x] Phase 0.6: OpenAI Symphony alignment and board bootstrap docs
- [x] Phase 0.7: Basecamp reference roadmap and GoldenTicket model stub
- [x] Phase 0.8: Codex runner boundary, RCC SQLite smoke robot, and WorkAI disposable board fixture
- [x] Phase 1: Real CLI-backed Fizzy tracker adapter primitives
- [x] Phase 2: Golden-ticket discovery from Fizzy cards
- [x] Phase 3: Fizzy producer -> workitems queue CLI command path
- [x] Phase 4: Split RCC tasks into per-suite Robot projects under `robot_tests/`
- [x] Phase 5: Add Python, uv, and RCC GitHub Actions workflows
- [x] Phase 5.1: Hosted uv and automatic RCC proof
- [ ] Phase 6: SDK-backed live smoke agent over the WorkAI fixture
- [ ] Phase 7: reporter/observability back to Fizzy
- [ ] Phase 8: harden polling reconciler scheduling and orphan recovery
- [ ] Phase 9: hardened safety model

## Target Robot Suite Layout

The RCC/Robot test surface now has independent starter suites:

```text
robot_tests/
  env_resolve/
  sqlite_workitem_flow/
  fizzy_contract/
  fizzy_parity/
  prompt_card_smoke/              # workflow_dispatch/manual only
  workai_production_smoke/        # workflow_dispatch/manual only
    robot.yaml
    conda.yaml
    test.robot
    devdata/
    README.md
```

Each suite is runnable on its own with RCC and owns its environment file,
Robot entry, devdata directory, and README. Shared implementation code still
lives under `robots/workitems/` for now; new suite work should target
`robot_tests/<suite>/` and keep live Fizzy mutation opt-in.

## Per-Suite RCC Commands

Automatic benchmark proof suites:

```bash
rcc ht vars -r robot_tests/env_resolve/robot.yaml --json
rcc run -r robot_tests/env_resolve/robot.yaml --dev -t EnvResolve --silent
rcc run -r robot_tests/sqlite_workitem_flow/robot.yaml --dev -t SmokeSQLiteWorkitemFlow --silent
rcc run -r robot_tests/fizzy_contract/robot.yaml --dev -t FizzySymphonyContractTest --silent
rcc run -r robot_tests/fizzy_parity/robot.yaml --dev -t FizzySymphonyParityContract --silent
```

Manual/gated `workflow_dispatch` suites:

```bash
FIZZY_SYMPHONY_WORKSPACE="$PWD/tmp/prompt-card-workspace" \
FIZZY_SYMPHONY_PROMPT="Make a tiny safe change and report proof." \
FIZZY_SYMPHONY_BOARD_ID="board_disposable" \
FIZZY_SYMPHONY_CARD_NUMBER="42" \
rcc run -r robot_tests/prompt_card_smoke/robot.yaml --dev -t PromptCardSmoke --silent

WORKAI_SMOKE_BOARD_ID="board_disposable" \
rcc run -r robot_tests/workai_production_smoke/robot.yaml --dev -t WorkAIProductionSmoke --silent
```
