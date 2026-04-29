# SPEC 28 conformance coverage

This checklist maps every required group in `SPEC.md` section 28 to the current automated coverage layer.
Status values are intentionally limited to `passing`, `newly covered`, or `deferred`.

### Config generation
- Status: passing
- Tests: `test/config.test.js`
- Coverage: annotated template fields, environment indirection, relative path resolution, server/status fields, webhook management fields, ETag polling fields, workpad fields, safety fields, runner fields, and board route defaults.

### Startup validation
- Status: passing
- Tests: `test/validation.test.js`, `test/setup.test.js`
- Coverage: missing secrets, invalid Fizzy access, invalid bot user, duplicate golden tickets, tag-only instruction cards, missing completion policy, board-level tickets, managed webhook misconfiguration, entropy warnings, missing `WORKFLOW.md`, unsafe cleanup policy, invalid runner, invalid server port, and invalid claim mode.

### Golden-ticket parsing
- Status: passing
- Tests: `test/validation.test.js`, `test/domain.test.js`
- Coverage: native golden requirement, normalized tags with and without `#`, aliases, unknown managed tags, conflicting route tag families, route ID and fingerprint stability, duplicate normalized completion columns, same-column rejection, and completion cycle rejection.

### Unsafe completion policy rejection
- Status: passing
- Tests: `test/validation.test.js`, `test/completion.test.js`
- Coverage: missing completion, conflicting completion tags, missing move target, unavailable completion mutators failing loudly, malformed completion-failure marker parsing, completion-failure marker creation, and cleanup eligibility gates tied to proof/result/marker/release evidence.

### Card routing precedence
- Status: passing
- Tests: `test/router.test.js`
- Coverage: allowed and disallowed card overrides, unknown workspace/model validation, rerun tag handling, no-repeat marker behavior, completion-failure marker behavior, postponed and closed card skips, and golden-ticket card skips.

### Fizzy API usage
- Status: newly covered
- Tests: `test/etag-cache.test.js`, `test/fizzy-client.test.js`, `test/setup.test.js`, `test/polling.test.js`
- Coverage: API-filtered golden and candidate discovery, ETag `304 Not Modified` handling, ETag cache invalidation, live account-scoped Fizzy JSON transport, card-number resource routes, user/tag listing, assignment/watch visibility, workpad comment update paths, daemon-managed step updates, webhook create/update/reactivate/deliveries, safe API error metadata, and raw-body webhook HMAC verification.
- Remaining: live API smoke testing against a disposable board still needs credentials and an explicit operator-approved environment.
- Follow-up: `fizzy-symphony: live Fizzy API smoke test with disposable board`.

### Workspace isolation
- Status: passing
- Tests: `test/workspace.test.js`, `test/recovery.test.js`
- Coverage: deterministic workspace key, named workspace identity, metadata mismatch preservation, source snapshot requirements, path escape rejection, retry reuse semantics, branch naming, guard file writes, workspace metadata scanning, and startup preservation for missing or mismatched guards.

### Port allocation
- Status: newly covered
- Tests: `test/listener.test.js`, `test/instance-registry.test.js`, `test/status-discovery.test.js`
- Coverage: fixed-port collision, bind-and-hold listener ownership, next-available allocation, random port allocation, registry write after listen, default bind host, and stale registry inspection.
- Follow-up: `fizzy-symphony: harden port allocation and local instance registry lifecycle`.

### Multi-instance claim behavior
- Status: newly covered
- Tests: `test/claims.test.js`, `test/orchestrator-state.test.js`, `test/reconciler.test.js`
- Coverage: simultaneous race ordering, loser skip, non-expired claim skip, expired claim steal after grace, released claim unblocking, long-running active-run renewal before steal, multiple renewal comments, renewal failure cancellation, release failure reporting, and stale instance registry surfaces.

### Safe cleanup
- Status: newly covered
- Tests: `test/completion.test.js`, `test/recovery.test.js`, `test/workspace.test.js`
- Coverage: dirty/untracked/unpushed proof gates through cleanup eligibility, missing proof/result/marker/release preservation, durable proof outside cleanup target, force removal forbidden by policy validation, and interrupted cleanup recovery.
- Follow-up: `fizzy-symphony: implement clean-only workspace removal executor`.

### Runner health checks
- Status: passing
- Tests: `test/runner-contract.test.js`, `test/codex-app-server-transport.test.js`, `test/codex-cli-app-server-runner.test.js`, `test/validation.test.js`, `test/reconciler.test.js`, `test/orchestrator-state.test.js`
- Coverage: fake-runner seam preservation, Codex app-server argv/cwd launch without shell eval, JSONL request/response matching, initialize handshake, detect/validate/health success, malformed protocol/stderr/exit handling, input-required failure in unattended mode, timeout/stall cancellation, shutdown cancellation escalation to session stop/process termination, session stop after successful completion, metadata extraction, explicit `agent.max_turns > 1` rejection until same-thread continuation is implemented, and runner failure release/status behavior.

### Status snapshot
- Status: newly covered
- Tests: `test/status.test.js`, `test/status-cli.test.js`, `test/status-discovery.test.js`
- Coverage: health, readiness, runner health, active runs, claims, retry queue, recent completions/failures, workspace cleanup state, validation errors, token/rate metadata, managed webhook warnings, startup recovery, lifecycle recovery, instance registry discovery, and operator-readable status output.

### Event ingestion
- Status: newly covered
- Tests: `test/server.test.js`, `test/daemon.test.js`, `test/reconciler.test.js`, `test/polling.test.js`
- Coverage: webhook signature verification, event ID dedupe, stale timestamp rejection, self-authored daemon comment ignore unless rerun is explicit, lifecycle action mapping to candidate/cancel/route-refresh hints, webhook hints routed through fresh router validation before claims, polling candidate discovery with API filters, missed-webhook reconciliation through polling, and active-card route mismatch preemption.
- Remaining: live disposable-board webhook smoke still requires credentials and an explicit operator-approved environment.
- Follow-up: `fizzy-symphony: live Fizzy API smoke test with disposable board`.
