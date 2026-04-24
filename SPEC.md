# Fizzy Symphony Spec

## Purpose

Fizzy Symphony is a dry-run-first scaffold for orchestrating coding agents
against a Fizzy board. Its job is to normalize tracker data, define safe state
transitions, and produce the exact Fizzy CLI commands that later phases may run.

## Core Domain Model

- `FizzyCard`: canonical normalized tracker card.
- `Agent`: worker execution persona and limits.
- `CardAdapter`: compatibility wrapper used by the demo planning scaffold.
- `Board`: ordered collection of cards for a Fizzy board.
- `TrackerAdapter`: contract for reading cards and writing comments/state updates.
- `FizzyCLIAdapter`: dry-run adapter that builds Fizzy CLI commands.

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

## Tracker Adapter Contract

A tracker adapter must provide these operations:

- `fetch_candidate_cards()`
- `fetch_cards_by_states(states)`
- `fetch_card_states_by_ids(card_ids)`
- `create_comment(card_id, body)`
- `update_card_state(card_id, state_name)`

These operations are intentionally small so future dispatch logic can stay
tracker-agnostic.

## Workspace Model

Each claimed card maps to a dedicated workspace rooted under a configured
workspace directory. The expected working shape is one branch/worktree per card,
using the card branch name when present and a deterministic fallback when not.

## Active States

Active states are the states in which a card is eligible for worker activity or
already under active execution:

- `Ready for Agents`
- `In Flight`
- `Needs Input`
- `Synthesize & Verify`
- `Ready to Ship`

## Terminal States

Terminal states indicate no more automated work should occur:

- `Done`
- `Not Now`

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
- No direct HTTP or API behavior is allowed in the scaffold.
- No daemon/background loop behavior is allowed yet.
- Fizzy CLI mutations must target the visible card `number`, not only the internal `id`.
- Workers claim exactly one card at a time.
- Workers may edit only approved paths for the claimed card.
- Card comments and state updates must reflect actual proof of work.
