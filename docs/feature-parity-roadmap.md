# Feature Parity Roadmap

This roadmap uses `fizzy-popper` as prior art without turning
`fizzy-symphony` into a TypeScript daemon clone.

## Product Shape

`fizzy-symphony` should support two operating modes.

Simple mode:

```text
Fizzy board -> polling -> Codex -> comment/move card
```

Durable mode:

```text
Fizzy board -> producer -> Robocorp workitem queue -> Codex/RCC worker -> reporter -> Fizzy
```

Simple mode keeps the project understandable. Durable mode is the differentiator
for larger boards, multiple worker processes, multiple Codex accounts, and
crash/retry handling.

## Fizzy Board Semantics

Fizzy has built-in system lanes:

| Lane | Pseudo ID | API kind | Meaning |
| --- | --- | --- | --- |
| `Maybe?` | `maybe` | `triage` / `stream` | Active cards without a custom column |
| `Not Now` | `not-now` | `not_now` | Postponed cards |
| `Done` | `done` | `closed` | Closed cards |

These are not custom columns to create or delete. Custom workflow columns should
be discovered by ID and can be configured by golden tickets.

## Phase A: Tracker Adapter Correctness

- Treat visible card `number` as the CLI command identifier.
- Treat internal card `id` as the reconciliation/deduplication identifier.
- Move cards by custom column ID or by explicit pseudo-lane operation:
  `untriage`, `postpone`, or `close`.
- Preserve dry-run CLI command generation until real execution is explicitly
  enabled.

## Phase B: Golden-Ticket Discovery and Parsing

- Parse `#agent-instructions` cards into a `GoldenTicket` model.
- Include `card_id`, `card_number`, `column_id`, `column_name`, `prompt`,
  `steps`, `backend`, and `completion_policy`.
- Start with `#codex` as the supported backend tag.
- Support completion policies: comment-only, close, and move-to-column.
- Do not execute runtime behavior in this phase.

## Phase C: Producer Creates Workitems

- Poll candidate cards from configured boards.
- Skip golden-ticket cards, closed cards, postponed cards, and cards already
  leased.
- Enqueue one durable workitem per eligible card.
- Store enough payload to reproduce the run intent without making workitems the
  human source of truth.

## Phase D: Codex Worker Consumes Workitems

- Reserve one workitem at a time.
- Create or reuse an isolated workspace per card.
- Build the prompt from workflow contract, golden ticket, card, steps, and
  comments.
- Run Codex through an injected runner first. Prefer the official Codex SDK as
  the future runtime path, with non-interactive CLI execution as a fallback.
- Emit a result workitem with proof and metadata.

Runner options:

- `CodexSdkRunner`: controls local Codex agents through the Codex SDK/app-server.
- `CodexCliRunner`: shells out to `codex` only for compatibility.

Do not build a custom coding-agent harness here. The desired worker is Codex,
not an in-house clone of Codex using the Agents SDK.

## Phase E: Reporter Moves Cards

- Consume result workitems.
- Post proof back to the original Fizzy card.
- Apply the golden-ticket completion policy.
- Retry reporter failures without rerunning the worker.
- Confirm final card state after mutation.

## Phase F: Polling Reconciler

- Refresh golden tickets.
- Reconcile running workitems against current card state.
- Release or fail leases for cards that moved to `Done`, `Not Now`, or a
  non-agent column.
- Recover orphaned reserved items after worker crashes.

## Phase G: Optional Webhooks

- Add webhook ingestion after polling works.
- Use webhooks to accelerate reconciliation, not replace it.
- Deduplicate events, then fall back to polling for correctness.

## Phase H: Optional Direct OpenAPI Adapter

- Implement a real API adapter from `basecamp/fizzy-sdk/openapi.json` when the
  CLI adapter is no longer enough.
- Keep the CLI adapter useful for dry-run/operator workflows.
- Do not invent a fake Python SDK surface.

## Distributed Scale Story

The durable mode should eventually support:

- multiple worker machines;
- multiple Codex accounts or credential pools;
- queue-level capacity limits;
- per-column or per-backend concurrency;
- retry/backoff by failure type;
- artifact storage outside Fizzy comments;
- reporter-only retries;
- metrics for queued, leased, succeeded, failed, and stale work.

This is the reason to keep `fizzy-symphony` alive beside `fizzy-popper`.
