# Fizzy Symphony Spec

## Purpose

Fizzy Symphony is a dry-run-first scaffold for orchestrating coding agents
against a Fizzy board. Its job is to normalize tracker data, define safe state
transitions, and produce the exact Fizzy CLI commands that later phases may run.

The architecture follows OpenAI Symphony's tracker-first model: the existing
tracker board remains the human source of truth, one issue/card maps to one
agent task, and worker proof is written back to the original issue/card. This
project diverges by using Robocorp workitems as durable queue plumbing for
claimed/running/result state instead of treating one daemon process as the only
owner of orchestration state.

This repository uses `basecamp/fizzy-popper` as prior art for the simple
board-native loop, but it is only worth keeping if it also supports a durable
distributed mode for many workers, many Codex accounts/runtimes, and
crash-safe handoffs.

Boundary:

- `fizzy-symphony` owns board semantics, workflow state, Codex runner policy,
  workspace policy, and reporter output.
- `robocorp-adapters-custom` owns reserve/release/fail/output queue mechanics.
- Fizzy owns the visible board, cards, comments, and columns.

## Core Domain Model

- `FizzyCard`: canonical normalized tracker card.
- `GoldenTicket`: board-native routing contract parsed from a Fizzy card tagged
  `#agent-instructions`.
- `Agent`: worker execution persona and limits.
- `CardAdapter`: compatibility wrapper used by the demo planning scaffold.
- `Board`: ordered collection of cards for a Fizzy board.
- `TrackerAdapter`: contract for reading cards and writing comments/state updates.
- `FizzyCLIAdapter`: dry-run adapter that builds Fizzy CLI commands for preview/debugging.
- `FizzyOpenAPIAdapter`: future real adapter to be implemented from `basecamp/fizzy-sdk/openapi.json`.
- `SymphonyColumn`: recommended tracker column for the upstream-inspired flow.
- `RobocorpWorkitemConfig`: environment contract for the published adapter
  package.

## Normalized Fizzy Card Shape

The canonical `FizzyCard` fields are:

- `id`
- `number`
- `identifier`
- `title`
- `description`
- `state`
- `url`
- `labels`
- `priority`
- `blocked_by`
- `created_at`
- `updated_at`
- `branch_name`
- `column_id`

`number` is the visible card number and is the identifier used by Fizzy CLI card
commands. `id` remains the internal stable tracker identifier.

## Golden Ticket Shape

A golden ticket is a Fizzy card tagged `#agent-instructions` that lives in the
column it configures. It is inspired by `fizzy-popper`, but this scaffold treats
it as routing policy only; it does not execute the card by itself.

The `GoldenTicket` fields are:

- `card_id`
- `card_number`
- `column_id`
- `column_name`
- `prompt`
- `steps`
- `backend`
- `completion_policy`

Supported backend tags start with `#codex`. Future tags may include `#claude`,
`#opencode`, `#anthropic`, and `#openai`.

Supported completion policies:

- no completion tag: post a comment only
- `#close-on-complete`: post a comment, then close the card
- `#move-to-<column-name>`: post a comment, then move to the named custom column

## Tracker Adapter Contract

A tracker adapter must provide these operations:

- `get_card(card_number)`
- `fetch_candidate_cards()`
- `fetch_cards_by_states(states)`
- `fetch_card_states_by_ids(card_ids)`
- `create_comment(card_number, body)`
- `move_card_to_column(card_number, column_id)`
- `assign_card(card_number, user_id)`
- `self_assign_card(card_number)`
- `claim_card(card_number, in_flight_column_id, comment_body, assignee_id=None, self_assign=False)`

These operations intentionally separate native tracker capabilities from
`fizzy-symphony` orchestration semantics. `claim_card(...)` is composite: at
minimum it moves the visible card number into the in-flight column and leaves a
worker-identity comment. Assignment is optional for MVP, and a dedicated bot
user is not required to validate the loop.

## Workspace Model

Each claimed card maps to a dedicated workspace rooted under a configured
workspace directory. The expected working shape is one branch/worktree per card,
using the card branch name when present and a deterministic fallback when not.

## Active States

Active states are the states in which a card is eligible for worker activity or
already under active execution. These are custom workflow columns, not Fizzy's
immutable system lanes:

- `Ready for Agents`
- `In Flight`
- `Needs Input`
- `Synthesize & Verify`
- `Ready to Ship`

## Recommended Board Columns

Fizzy Symphony expects an existing board by default. `fizzy-symphony init-board`
prints dry-run commands to add any missing recommended custom columns:

- `Shaping`
- `Ready for Agents`
- `In Flight`
- `Needs Input`
- `Synthesize & Verify`
- `Ready to Ship`

Fizzy's built-in system lanes are always represented separately:

- `Maybe?` / pseudo column `maybe` / API stream or triage view
- `Not Now` / pseudo column `not-now` / API `not_now`
- `Done` / pseudo column `done` / API `closed`

Do not create, delete, or treat those system lanes as custom columns.

## Terminal States

Terminal states indicate no more automated work should occur:

- `Done`
- `Not Now`

## Codex Runner Strategy

The early scaffold previews Codex work with dry-run command strings only. Future
runtime work should use OpenAI's Codex harness rather than building a custom
coding-agent harness here.

Preferred runner:

- `CodexSdkRunner`: controls local Codex agents through the official Codex
  SDK/app-server.

Fallback runner:

- `CodexCliRunner`: uses non-interactive `codex` CLI execution when the SDK path
  is unavailable or too immature for the current environment.

Non-goal:

- Do not build a custom shell/apply-patch/tool harness with the OpenAI Agents
  SDK. The intended worker is Codex itself acting as a coding agent over a
  repository. Direct OpenAI model calls may still be useful for narrow helper
  tasks, but they are not the main card-execution runtime.

## Handoff States

Handoff states represent ownership transfer between worker execution and lead or
integration review:

- `Needs Input`
- `Synthesize & Verify`
- `Ready to Ship`

## Proof-of-Work Rules

A worker must leave proof of work before handoff. Proof of work should include:

- branch/workspace used
- files changed or intentionally left untouched
- validation commands run
- validation outcome
- blockers or follow-up notes when applicable

## Merge/Integration Rules

Only cards in integration-oriented states should be synthesized or prepared for
shipping. Integration work must verify the branch is current, confirm validation
passes, and preserve the card as the source of truth for scope and status.

## Safety Invariants

- Phase 0 is dry-run only; no subprocess execution is allowed.
- No direct HTTP or API behavior is allowed in the scaffold beyond the explicit
  future OpenAPI stub.
- No daemon/background loop behavior is allowed yet.
- The system must not create a hidden board by default; it configures or checks
  an existing Fizzy board unless the user explicitly opts into creation later.
- Fizzy CLI mutations must target the visible card `number`, not only the internal `id`.
- Workers claim exactly one card at a time.
- Claim is modeled as a composite orchestration operation, not a required native
  Fizzy `card claim` command.
- Workitems may hold execution custody, but Fizzy remains the source of truth
  for human workflow state.
- Workers may edit only approved paths for the claimed card.
- Card comments and state updates must reflect actual proof of work.
