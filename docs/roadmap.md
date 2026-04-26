# Roadmap

## Executive Status

`fizzy-symphony` is currently a pre-alpha, locally exercised orchestration
prototype. The safest status summary is:

| Area | Status | Notes |
| --- | --- | --- |
| Core models, dry-run Fizzy commands, golden-ticket parsing, workitem queue seam, producer/worker/reporter flow | Implemented | Unit-tested Python paths exist. External tracker mutation remains guarded. |
| SQLite workitem smoke helper and WorkAI sample fixture | Tested locally | Tests exercise the flow with in-memory or local adapters and scripted runners. |
| CI coverage for Python, uv, and RCC/Robot execution | Workflow files added | GitHub Actions still needs a hosted run to prove the matrix end to end. |
| RCC Robot suite split | Implemented for initial suites | SQLite workitem, Fizzy contract, and Fizzy parity suites live under `robot_tests/<suite>/`. |
| Live Fizzy smoke | Live smoke gated | Live board/card mutation requires explicit env, real card mapping, and operator cleanup. |
| Production daemon / polling service | Not implemented | There is no hardened long-running daemon, scheduler, or orphan-recovery loop yet. |
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
- [ ] Phase 6: SDK-backed live smoke agent over the WorkAI fixture
- [ ] Phase 7: reporter/observability back to Fizzy
- [ ] Phase 8: polling reconciler and orphan recovery
- [ ] Phase 9: hardened safety model

## Target Robot Suite Layout

The RCC/Robot test surface now has independent starter suites:

```text
robot_tests/
  sqlite_workitem_flow/
  fizzy_contract/
  fizzy_parity/
  <future-suite>/
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
