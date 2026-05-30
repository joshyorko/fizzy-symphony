# v1 → v2 Migration Inventory

A feature-by-feature inventory of the v1 runtime, mapped to its v2 cockpit
contract and a keep / defer / drop disposition for the spike. This is the
"what exists and where it goes" map — **no v1 code was deleted**; this document
is the plan, not the surgery.

Legend for **Disposition**:
- **Keep** — modelled in the v2 contract now (status field, capability, and/or
  command).
- **Defer** — recognized in the contract surface but not wired in the spike
  (adapter boundary or dry-run only).
- **Drop** — intentionally out of the v2 cockpit scope.

| # | Feature | v1 source (representative) | v1 tests | User-facing command | v2 contract surface | Disposition | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Setup / onboarding wizard | `src/setup.js`, `src/setup-wizard.js` | `test/setup*.test.js` | `fizzy-symphony setup` | — (stays v1) | Drop (from cockpit) | Cockpit assumes setup already ran; not an operator-cockpit concern. |
| 2 | Config load/validate | `src/config.js`, `src/validation.js` | `test/config.test.js`, `test/validation.test.js` | implicit | `InstanceStatus`, readiness blockers | Keep | v2 reads endpoint/instance from status. |
| 3 | Board & route discovery | `src/domain.js`, `src/fizzy-client.js` | `test/domain.test.js`, `test/fizzy-client.test.js` | `fizzy-symphony status` | `boards[]`, `routes[]`, `FizzyPort.listBoards/listCards` | Keep | FizzyPort is SDK-independent; fake serves fixtures. |
| 4 | Golden-ticket routing | `src/router.js`, `src/workflow.js` | `test/router.test.js`, `test/workflow.test.js` | start/daemon | `route.golden` capability, `CardRuntimeStatus.golden` | Keep | Golden cards flagged in lanes. |
| 5 | Start / daemon loop | `src/daemon.js`, `src/scheduler.js`, `src/operator.js` | `test/daemon.test.js`, `test/scheduler.test.js` | `fizzy-symphony start` | `createRuntime`, `/v2/health`, `/v2/ready` | Keep (skeleton) | v2 daemon is a status/command runtime skeleton, not the full scheduler. |
| 6 | Status reporting | `src/status.js`, `src/status-cli.js`, `src/status-discovery.js` | `test/status*.test.js` | `fizzy-symphony status` | `SymphonyStatus`, `/v2/status` | Keep | v2 schema is `fizzy-symphony-status-v2` (camelCase). |
| 7 | Dashboard / terminal UI | `src/dashboard.js`, `src/terminal-ui.js`, `src/terminal-renderer.js` | `test/dashboard.test.js`, `test/terminal-*.test.js` | `fizzy-symphony dashboard` | `CockpitModel`, `renderCockpitText`, interactive cockpit | Keep | v2 cockpit is the successor surface; v1 dashboard remains. |
| 8 | Run lifecycle / registry | `src/run-registry.js`, `src/reconciler.js` | `test/run-registry.test.js`, `test/reconciler.test.js` | observed in status | `RunStatus`, `RunBuckets`, `/v2/runs` | Keep | Bucketed by state. |
| 9 | Claim markers | `src/claims.js`, `src/marker-comment.js` | `test/claims.test.js` | implicit | `ClaimStatus`, `claim.*` capability | Keep (model) | Claim state surfaced; mutation deferred. |
| 10 | Workspace / worktree metadata | `src/workspace.js` | `test/workspace.test.js` | implicit | `WorktreeStatus`, `/v2/worktrees` | Keep | Dirty/preserved flags + dirty paths. |
| 11 | Dirty-worktree protection | `src/workspace.js`, `src/recovery.js` | `test/recovery.test.js`, `test/workspace.test.js` | implicit | `WorktreeStatus.dirty`, hazard label "Spill / hazard" | Keep | Hazard is visually obvious in render. |
| 12 | Worktree preserve / cleanup | `src/recovery.js`, `src/workspace.js` | `test/recovery.test.js` | implicit | `worktree.preserve` / `worktree.cleanup` commands | Defer | Validated + dry-run only in spike. |
| 13 | Goal-closing doctor | `src/recovery.js` (doctor) | covered in recovery tests | `--goal` doctor | `DoctorStatus`, `doctor.goal` capability | Keep | `goalClosable` + blockers, themed "Factory cannot close". |
| 14 | Workflow loading / cache fallback | `src/workflow.js`, `src/git-source-cache.js` | `test/workflow.test.js`, `test/git-source-cache.test.js` | implicit | `route.model/backend` fields | Defer | Routing metadata only; loader not re-implemented. |
| 15 | Retry queue | `src/scheduler.js`, `src/run-registry.js` | `test/scheduler.test.js` | observed in status | `RetryQueueItem[]` | Keep (model) | Surfaced in status; scheduling deferred. |
| 16 | Capacity refusals (`--max-agents`) | `src/scheduler.js` | `test/scheduler.test.js` | start flag | `CapacityRefusal[]` | Keep (model) | Refusals surfaced as diagnostics. |
| 17 | Webhook filtering | `src/listener.js` | `test/listener.test.js` | listener | `webhook.filter` capability, `FizzyPort.verifyWebhook` | Defer | Capability advertised; adapter not wired. |
| 18 | Managed webhooks | `src/listener.js`, `src/fizzy-http-client.js` | `test/listener.test.js` | listener | `FizzyPort.listWebhooks` (optional) | Defer | Optional port method; not wired. |
| 19 | Runner health monitoring | `src/runner-health.js`, `src/runner-contract.js` | `test/runner-contract.test.js` | observed | `CodexRunnerPort.health`, `runner.health` capability | Keep | Health drives `codex.run` enablement. |
| 20 | Codex CLI runner | `src/codex-cli-app-server-runner.js` | `test/codex-cli-app-server-runner.test.js` | start | `createCodexAdapter({mode:"cli-app-server"})` | Defer | Boundary; contract `codex-runner-cli-app-server-v1`. |
| 21 | Codex app-server transport | `src/codex-app-server-transport.js` | `test/codex-app-server-transport.test.js` | start | `CodexRunnerPort` streaming shape | Defer | Mirrored by fake's streaming. |
| 22 | Codex SDK compatibility | `src/client-factories.js`, `src/fizzy-sdk-adapter.js` | `test/fizzy-sdk-adapter.test.js` | start | `createCodexAdapter({mode:"sdk"})` | Defer | Contract `codex-runner-sdk-v1`. |
| 23 | Run cancellation | `src/run-registry.js`, `src/operator.js` | `test/run-registry.test.js` | operator | `run.cancel` command, `CodexRunnerPort.cancelTurn` | Defer | Validated + dry-run; fake supports cancel. |
| 24 | Session stop | `src/operator.js` | covered | operator | `session.stop` command, `stopSession` | Defer | Validated + dry-run. |
| 25 | Process termination | `src/codex-cli-app-server-runner.js` | covered | operator | `CodexRunnerPort.terminateOwnedProcess` (optional) | Defer | Optional port method. |
| 26 | Dispatch pause / resume | `src/operator.js`, `src/scheduler.js` | covered | operator | `dispatch.pause` / `dispatch.resume`, `control.dispatch` | Keep | "Lock / unlock factory" actions; dry-run in spike. |
| 27 | Card rerun / move | `src/operator.js`, `src/router.js` | covered | operator | `card.rerun` / `card.move` commands | Defer | Validated + dry-run; `card.move` needs target column. |
| 28 | Completion proof | `src/completion.js` | `test/completion.test.js` | observed | `CardRuntimeState: completed`, run state | Keep (model) | Completion reflected in card/run state. |
| 29 | Event / activity log | `src/logger.js`, polling events | `test/logger.test.js` | dashboard | `RuntimeEvent[]`, `/v2/events`, `diagnostics.events` | Keep | v2 event log with JSONL export. |
| 30 | Non-TTY behavior | `src/cli-opener.js`, `src/dashboard.js` | `test/cli-opener.test.js` | all | `renderCockpitText`, `--once`, `--json` | Keep | Static frame + machine output; no terminal grab. |
| 31 | Polling / etag cache | `src/polling.js`, `src/etag-cache.js` | `test/polling.test.js`, `test/etag-cache.test.js` | internal | endpoint refresh in CLI | Defer | v2 reads on demand; no long-poll loop in spike. |
| 32 | Instance registry | `src/instance-registry.js`, `src/instance.js` | `test/instance*.test.js` | discovery | `InstanceStatus` | Keep (model) | Single-instance assumption in spike. |

## Summary

- **Keep (modelled now):** status schema, boards/routes/cards, runs, worktrees,
  doctor, capabilities, dispatch pause/resume, events, non-TTY rendering — the
  observable cockpit surface.
- **Defer (boundary / dry-run):** all *mutating* operations (run cancel, session
  stop, card rerun/move, worktree preserve/cleanup) and all *live* integrations
  (Fizzy SDK/HTTP, Codex SDK/CLI, webhooks, polling). These have honest contract
  surfaces but are not wired — no fake controls.
- **Drop (out of cockpit scope):** setup/onboarding.

The v2 cockpit therefore gives an operator a truthful, read-mostly view of the
factory plus a validated command palette whose effects are explicitly dry-run
until the adapters are wired.
