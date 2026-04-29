# Fizzy Symphony Service Specification

## 1. Status

Status: Draft v0.2.

This document is a product and implementation specification for a fresh `fizzy-symphony`
orchestrator. It is not an implementation plan for modifying `fizzy-popper`, and it MUST NOT be
read as code.

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and
`OPTIONAL` in this document are to be interpreted as described in RFC 2119.

Research inputs:

- OpenAI Symphony sources establish the long-running service, tracker-driven reconciliation,
  per-ticket workspace, `WORKFLOW.md`, Codex app-server, bounded concurrency, and observability
  pattern.
- Fizzy Popper sources establish the Fizzy board control plane, webhook and polling ingestion,
  golden tickets, column-aware routing, backend tags, completion tags, setup bootstrap, and current
  workspace behavior.
- The pain points in this brief define the required corrections for a new design.

Implementation runtime:

This specification is runtime-neutral. The implementation runtime MUST be selected before coding
begins and recorded in `docs/runtime-decision.md`.

The selected runtime MUST support:

- a long-running local daemon
- bounded concurrent card workers
- local HTTP status/webhook server
- deterministic workspace/worktree management
- Codex app-server or SDK-shaped runner integration
- safe process shutdown and cleanup

The Codex runtime MUST use one SDK-shaped runner interface. The first implementation MAY use the
official TypeScript SDK, a future stable SDK for another language, or a generated/manual app-server
JSON-RPC client depending on the selected runtime. The app-server protocol is the required fallback
contract. Routing, reconciliation, workspace, claim, completion, and observability code MUST NOT
depend on which runner implementation is active.

## 2. Purpose

`fizzy-symphony` is a long-running local daemon that turns Fizzy boards into a human-facing control
plane for Codex-backed software work.

The product identity is **Fizzy-backed Symphony**:

- OpenAI Symphony supplies the implementation pattern: tracker-driven reconciliation, isolated
  workspaces, repository-owned workflow policy, Codex app-server execution, bounded concurrency,
  restart handling, and observability.
- Fizzy Popper supplies the product surface: Fizzy boards, columns, cards, tags, comments, webhooks,
  polling, golden-ticket routing, and board-native setup.

The service MUST NOT collapse these responsibilities into a simple board-triggered backend runner.
Golden tickets decide which route applies to a card; they do not replace repository policy,
workspace lifecycle, run supervision, or Codex protocol handling.

### Upstream baseline and Fizzy extensions

The service follows Symphony's orchestration baseline, then adds Fizzy-specific safety and control
plane behavior. The spec MUST keep those layers explicit:

| Area | Upstream Symphony baseline | Fizzy-specific extension in this spec |
| --- | --- | --- |
| Tracker writes | The daemon schedules, reconciles, and reads tracker state. Task-specific tracker writes normally live in the workflow prompt and agent tools. | The daemon writes board-native claim, completion, completion-failure, and status comments because Fizzy comments/tags are the local coordination store. |
| `WORKFLOW.md` | Repository-owned runtime policy and prompt contract. | Local config owns Fizzy auth, boards, ports, instance identity, claim storage, status storage, and local safety defaults. Any runtime policy kept local is a deliberate divergence and MUST be documented. |
| Workspaces | Deterministic isolated workspace per task under a workspace root. | Deterministic git worktrees, branch/proof metadata, conservative cleanup, and cleanup guards are required hardening for multi-card Fizzy operation. |
| Observability | Structured logs are the minimum. Status surfaces are implementation-defined. | `/health`, `/ready`, `/status`, status snapshots, and instance discovery are MVP requirements for local multi-instance operation. |
| Codex execution | Codex app-server protocol is the upstream execution model. | A single SDK-shaped runner abstraction wraps either the preferred SDK implementation or the app-server fallback. |

The service MUST combine these patterns:

- Symphony-style orchestration:
  - long-running daemon
  - tracker-driven reconciliation
  - one task maps to one isolated workspace
  - bounded concurrency
  - repository-owned `WORKFLOW.md`
  - Codex SDK/app-server execution model
  - clear observability
- Fizzy-style control plane:
  - Fizzy boards, columns, cards, comments, and tags are visible work truth
  - webhook ingestion for low latency
  - polling reconciliation for correctness
  - native Fizzy golden cards tagged `#agent-instructions`
  - column-aware routing
  - setup that can create or validate board-native structure

Key design sentence:

> Fizzy owns visible work state; golden tickets own board-level routing; `WORKFLOW.md` owns
> repository execution policy; the daemon owns reconciliation, claims, workspaces, runner lifecycle,
> and safety.

## What we are no longer leaving on the table

This specification intentionally compares the current Fizzy API, Fizzy Popper behavior, and OpenAI
Symphony's service model before defining `fizzy-symphony`. The implementation MUST use this section
as a guardrail when cutting MVP scope.

Fizzy API capabilities adopted by this design:

- Native golden-card semantics: a dispatch-valid golden ticket is both `golden: true` and tagged
  `agent-instructions`.
- Filtered card discovery: the daemon SHOULD use `board_ids[]`, `column_ids[]`, `tag_ids[]`,
  `assignee_ids[]`, `assignment_status`, `indexed_by`, `sorted_by`, and `terms[]` where they reduce
  polling cost or make candidate discovery safer. Local route validation remains authoritative.
- ETag-aware polling: repeated board, card, comment, golden-ticket, user, tag, and webhook reads
  SHOULD use `If-None-Match`, and `304 Not Modified` responses MUST skip parse/reconciliation work
  for that resource.
- Webhook lifecycle management: setup SHOULD list, create, update, delete only when explicitly
  requested, and reactivate webhooks for managed boards.
- Assignment and watch as visibility signals: claimed cards SHOULD be assigned to the configured bot
  user and watched when configured, but assignment/watch MUST NOT replace structured claim leases.
- One persistent agent workpad comment per card, updated in place, separate from append-only claim
  and completion markers.
- Card steps as acceptance/execution checklist input, with optional daemon-managed step updates for
  validation progress when the route or `WORKFLOW.md` enables them.
- Users and tags listing during setup for bot assignee selection, tag ID resolution, and route
  validation.
- Entropy awareness: account/board auto-postpone settings and `card_auto_postponed` events are part
  of setup warnings and reconciliation behavior.
- Rich-text comments for reports, workpads, and proof links.

Fizzy API capabilities intentionally deferred from the MVP:

- Pins as an operator focus surface.
- Reactions/boosts as machine-readable status.
- Board publication/unpublication for public demo boards.
- Direct-upload attachments for screenshots, coverage reports, logs, or other large artifacts.
- Daemon-driven reopen, untriage, and Not Now transitions beyond cancellation/route handling.
- Daemon-driven card title/body rewrites except for explicit future policies.
- Deleting daemon comments or steps as normal operation; MVP behavior is update-in-place for the
  workpad and append-only for claims/completion proof.

OpenAI Symphony concepts adopted by this design:

- Repository-owned `WORKFLOW.md` with YAML front matter and prompt body.
- Deterministic per-card workspace isolation and preservation across retries.
- One authoritative orchestrator state for claims, running sessions, retries, cancellation, and
  reconciliation.
- Codex app-server behind an SDK-shaped runner interface, with an SDK runner allowed only after an
  exact supported SDK contract is selected.
- Retry/backoff, stall detection, cancellation states, and bounded concurrency.
- Multi-turn continuation on the same live Codex thread before handoff.
- Dynamic `WORKFLOW.md` reload with last-known-good behavior.
- Dispatch preflight validation and reconciliation before dispatch on every tick.
- Workspace lifecycle hooks declared by repository policy rather than hidden daemon code.

OpenAI Symphony concepts intentionally deferred or narrowed:

- Generic Linear tracker support; Fizzy is the only tracker for this product.
- A hosted or distributed orchestrator database; restart recovery is tracker, filesystem, and local
  status driven.
- A general workflow engine or arbitrary backend dispatcher.
- Automatic terminal workspace deletion; this design preserves work unless proof and cleanup guards
  pass.

## 3. Problem statement

Fizzy Popper demonstrates that a Fizzy board can dispatch agents, but the next design MUST remove
operational ambiguity before implementation.

The major problems to eliminate are:

- Multi-card concurrency is fragile when several agents share one working directory.
- Multiple local daemon instances can collide on ports, local state, and eligible cards.
- Setup requires too many disconnected manual steps and reveals unsafe routing too late.
- Config is not self-documenting enough for operators or coding agents.
- Missing completion tags can leave cards eligible forever and create processing loops.
- Golden-ticket semantics are underspecified.
- Card-level routing overrides are underspecified.
- Workspace cleanup can delete useful work before proof has been persisted.

## 4. Goals

`fizzy-symphony` MUST:

- Watch configured Fizzy boards and dispatch eligible work cards.
- Treat Fizzy as the visible control plane for humans.
- Use `WORKFLOW.md` as the repository policy contract for how work is executed.
- Use one deterministic isolated workspace or worktree per Fizzy card.
- Enforce one active run per card and bounded global concurrency.
- Coordinate local instances so two daemons do not work the same card.
- Support webhook ingestion and polling reconciliation.
- Fail startup on unsafe golden tickets, missing completion policy, duplicate routing, or invalid
  runner configuration.
- Generate a complete annotated config file during setup.
- Validate Fizzy access during setup and startup.
- Validate Codex runner availability as far as the selected runtime allows.
- Surface every dispatch, claim, runner, completion, and cleanup state through logs and status
  endpoints.
- Preserve workspaces unless proof has been recorded and cleanup is safe.

## 5. Non-goals

`fizzy-symphony` MUST NOT attempt to be:

- A Fizzy Popper rewrite with a different runner.
- A general-purpose workflow engine.
- A hosted multi-tenant control plane.
- A replacement for Fizzy board semantics.
- A replacement for repository-specific `WORKFLOW.md`.
- A system where golden tickets own deep coding workflow, branch rules, validation rules, PR/rework
  behavior, merge policy, or cleanup rules.
- A tool that hides all Codex authentication, model entitlement, billing, or local runtime setup.
- A tool that mutates the host operating system during setup.
- A migration path that preserves Popper's shared-directory execution model.
- A pluggable arbitrary-backend dispatcher for the MVP. Codex is the required runner, and every
  Codex path MUST use the same SDK-shaped runner abstraction.
- A dashboard-first product. Status surfaces are required, but card execution correctness is the
  core goal.

## 6. Design principles

- Board-first visibility: Humans MUST be able to understand work state from the Fizzy board.
- Reconciliation over event trust: Webhooks SHOULD reduce latency, but polling MUST be able to
  recover correctness after missed events, restarts, or local failures.
- Isolation by default: Every work card MUST resolve to its own workspace before Codex starts.
- Explicit ownership: The spec MUST keep Fizzy board, golden ticket, work card, `WORKFLOW.md`,
  local config, and daemon responsibilities separate.
- Fail closed on unsafe routing: Missing completion policy, duplicate golden tickets, unknown
  workspaces, and conflicting card tags MUST block dispatch.
- Durable proof before cleanup: The daemon MUST NOT delete work before status/proof metadata has
  been recorded.
- One runner abstraction: All Codex behavior MUST go through one SDK-shaped runner interface.
- Setup is product surface: Setup MUST explain what it can validate, what it cannot validate, and
  which manual steps remain.
- Linux-first local operation: Commands and defaults SHOULD fit a Bluefin/devcontainer/container
  workflow and SHOULD avoid host mutation.

## 7. System overview

At a high level:

1. Setup creates local config and board structure.
2. The daemon validates config, runner, Fizzy access, golden tickets, workspaces, and instance
   coordination.
3. Webhooks and polling produce candidate card events.
4. The router resolves a route from work card, golden ticket, config, and defaults.
5. The workspace manager resolves deterministic workspace identity without mutating the filesystem.
6. The claim store acquires a board-native lease for the card.
7. The workspace manager prepares the isolated workspace/worktree.
8. The workflow loader reads the repository's `WORKFLOW.md` from the source repo or prepared
   workspace.
9. The supervisor starts Codex through the runner abstraction and monitors continuation turns.
10. The daemon records status, comments back to Fizzy, applies completion policy, and preserves or
   cleans the workspace according to safety rules.

Required target flow:

1. User runs setup.
2. Setup validates Fizzy access.
3. Setup validates Codex runtime as much as possible.
4. Setup writes full annotated config.
5. Setup creates or validates board/golden-ticket structure.
6. User starts daemon.
7. Daemon validates config and golden tickets.
8. Daemon discovers eligible cards.
9. Daemon resolves card routing.
10. Daemon resolves route fingerprint and workspace identity.
11. Daemon acquires a board-native claim.
12. Daemon prepares isolated card workspace/worktree.
13. Daemon loads `WORKFLOW.md` from the resolved repo/workspace.
14. Daemon starts Codex through the SDK-shaped runner.
15. Daemon monitors turns, continuation, cancellation, stall, and failure.
16. Daemon records local status/proof.
17. Daemon reports back to Fizzy.
18. Daemon applies completion policy or writes a non-looping completion-failure marker.
19. Daemon preserves or cleans workspace according to safety policy.
20. Daemon releases or renews the claim according to run outcome.
21. Daemon repeats reconciliation.

## 8. Main components

`Setup Wizard`

- MUST collect and validate Fizzy API settings.
- MUST detect supported Codex runner options.
- MUST generate a complete annotated config file.
- MUST create or validate starter board/golden-ticket structure.

`Config Layer`

- MUST parse, validate, and expose typed configuration.
- MUST generate config from a complete annotated template. Implementations MAY round-trip comments,
  but preserving comments after arbitrary edits is not required for conformance.
- MUST support environment indirection for secrets.

`Fizzy Client`

- MUST list boards, columns, cards, comments, steps, tags, users, webhooks, and identity.
- MUST support Fizzy card filters used by this spec, including board, column, tag, assignee,
  assignment status, search terms, `indexed_by`, and sort filters where the API exposes them.
- MUST preserve and send ETags for cache-aware polling and MUST expose `304 Not Modified` as a
  first-class client result, not an error.
- MUST create boards, columns, native golden cards, smoke-test cards, comments, tags, steps, and
  card moves when setup or completion policies require them.
- MUST mark setup-created golden tickets through the goldness endpoint and validate `golden: true`
  for existing golden tickets.
- MUST create, update, reactivate, and list webhook deliveries for managed webhooks when configured.
- MUST update daemon-authored workpad comments and daemon-managed steps when those features are
  enabled.
- SHOULD support card assignment and watch operations for claim visibility when a bot user is
  configured.
- MUST verify webhook signatures when configured.

`Golden Ticket Registry`

- MUST discover effective agent routes from golden-ticket cards.
- MUST reject ambiguous or unsafe golden-ticket state.

`Router`

- MUST resolve card route decisions.
- MUST apply override precedence.
- MUST return explicit decisions: spawn, ignore, cancel, refresh, fail-validation.

`Reconciler`

- MUST run polling ticks.
- MUST refresh golden-ticket state.
- MUST discover eligible cards.
- MUST cancel orphaned active runs when cards leave eligible states.
- MUST cancel or pause active runs when the current card route fingerprint no longer matches the
  claimed route fingerprint.

`Supervisor`

- MUST own in-memory run state.
- MUST enforce bounded concurrency.
- MUST dispatch through the runner abstraction.
- MUST track active, retrying, completed, failed, stalled, and cancelled runs.

`Claim Store`

- MUST coordinate local instances.
- MUST use structured board-native claim comments for MVP leases.
- MAY add tags for human visibility, but tags MUST NOT be the only source of claim truth.
- SHOULD assign the card to the configured bot user and watch the card after claim acquisition when
  enabled. Assignment and watching are Fizzy-visible signals only; they MUST NOT replace the claim
  lease.
- MUST implement acquire, verify, renew, release, expire, and steal behavior before Codex starts.

`Workspace Manager`

- MUST resolve deterministic per-card workspace paths.
- MUST prepare and validate isolated workspaces.
- MUST implement safe cleanup.

`Workflow Loader`

- MUST load repository-owned `WORKFLOW.md`.
- MUST expose front matter and prompt body.
- MUST fail dispatch if the file is missing or invalid for the resolved workspace.

`Codex Runner`

- MUST expose an SDK-shaped interface.
- MUST support a Codex CLI app-server runner for MVP.
- SHOULD add a Codex SDK runner only when an exact SDK package and contract are selected.
- MUST expose health, structured event, result, and error metadata through the same interface.

`Status Surface`

- MUST expose health and status endpoints.
- SHOULD expose human-readable CLI status using endpoint discovery.
- MUST distinguish process liveness from readiness to dispatch work.

## 9. Domain model

### Fizzy board

Owns:

- visible work truth
- cards
- columns
- comments
- human workflow state

The board MUST NOT own local auth, workspace paths, runner defaults, or host-specific safety
settings.

### Golden ticket

Owns:

- route instructions for cards in its scope
- routing defaults for backend, model, workspace, persona, and completion
- backend/model/workspace hints
- completion policy

A golden ticket MUST be a Fizzy card with native `golden: true` status and an `#agent-instructions`
tag. It MUST NOT be processed as a work card. The tag identifies the card as an agent route; native
goldness makes that route visible through Fizzy's own product/API semantics.

Golden tickets MUST stay shallow. They MAY describe how cards in a column should be interpreted and
which route they should use, but they MUST NOT own branch rules, validation commands, PR policy,
rework handling, merge handling, cleanup safety, local filesystem policy, or Codex protocol details.

### Work card

Owns:

- concrete task
- task-specific instructions
- optional routing overrides
- acceptance details

A work card MAY override route fields only when the golden-ticket route and local config allow that
override.

### WORKFLOW.md

Owns:

- repo-specific execution policy
- validation expectations
- branch/PR/handoff rules
- rework, merge, blocked, and human-review behavior
- runtime hooks where applicable

`WORKFLOW.md` MUST NOT contain Fizzy API secrets or local daemon identity.

### Local config

Owns:

- auth references
- watched boards
- ports
- workspace registry
- local safety defaults
- runner defaults
- status/log storage

Local config MUST be generated with comments that describe defaults, requirements, environment
overrides, and examples.

Local config MUST be parsed strictly. Unknown top-level keys, unknown nested keys in known objects,
unknown enum values, invalid duration/port/path values, and cross-field conflicts MUST fail startup
validation unless the field is explicitly documented as an extension map.

### Daemon

Owns:

- polling/webhook ingestion
- reconciliation
- board-native claiming and lease renewal
- active run tracking
- bounded concurrency
- workspace lifecycle
- runner lifecycle
- retry, cancellation, stale-run, restart, and cleanup decisions
- status surface
- startup validation

The daemon MUST NOT silently reinterpret unsafe board state as safe.

### Responsibility split

The following boundary is REQUIRED:

| Surface | Owns | Must not own |
| --- | --- | --- |
| Fizzy board | Visible work truth: cards, columns, comments, tags, human state | Local auth, worktree paths, runner internals, cleanup safety |
| Golden ticket | Board-native route for cards in one column | Repo policy, long-running supervision, Codex protocol |
| `WORKFLOW.md` | How the agent should work inside a repository | Fizzy credentials, daemon identity, board claiming |
| Daemon | Reconciliation, claims, concurrency, workspaces, runner lifecycle, status, cleanup | Product task content or repo-specific engineering policy |
| Codex runner | Structured coding-agent execution | Routing, claiming, workspace selection, Fizzy completion |

### Additional entities

`Route`

- Effective routing record for one source column.
- Contains route ID, source board/column IDs, golden-ticket card ID and digest, instructions,
  backend, model, workspace selector, persona, priority, completion policy, allowed card overrides,
  unknown-tag policy, rerun policy, and concurrency limits.
- Board-level routes are not part of MVP and MUST be rejected unless a later implementation defines a
  complete board-level schema.

`Claim`

- Lease that says one daemon instance is responsible for one work card for a bounded period.
- Stored as an append-only structured daemon comment log on the work card in MVP.
- Contains claim ID, card ID, board ID, card digest, route ID, route fingerprint, workspace identity,
  instance ID, attempt ID, run ID, start time, renewed time, lease expiry, daemon version, and status.

`Run Attempt`

- One execution attempt for one card in one workspace.
- Contains attempt number, card/board IDs, route ID, route fingerprint, workspace identity, runner
  kind, SDK package or app-server command/version, model, Codex session/thread/turn IDs, timestamps,
  token/rate-limit metadata when available, output proof, Fizzy comment IDs, error code/message,
  remediation, and workspace cleanup state.

`Workspace`

- Filesystem directory or git worktree assigned to one card.
- Contains source repository material, run metadata, a daemon-owned guard file, route fingerprint,
  workspace identity, optional workspace-local proof copies, and cleanup guard state. Durable proof
  MUST live outside the workspace cleanup target.

`Agent Workpad`

- One daemon-authored Fizzy comment per work card used for live run status, current turn, retry
  state, validation evidence, and handoff summary.
- Stored separately from append-only claim and completion markers.
- Updated in place when possible. If update fails, the daemon MUST preserve the previous workpad,
  post a replacement that references the failed workpad ID, and surface a status warning.

## 10. Configuration model

The generated config SHOULD live at `.fizzy-symphony/config.yml` by default. A CLI flag MAY select a
different config path.

The generated file MUST be complete and annotated like a Helm `values.yaml`: every major option
MUST appear with default, explanation, required status, environment override, and example where
useful.

The complete annotated example generated config lives in `config.example.yml`. The example file is
illustrative, but the requirements in this section are normative.

Environment resolution rules:

- A string exactly matching `$VAR_NAME` MUST resolve from the environment.
- Missing required environment values MUST fail startup.
- Environment variables MUST NOT silently override explicit config values unless the config value
  references that environment variable.
- Relative paths MUST resolve relative to the config file directory unless a field explicitly says it
  resolves relative to a repository root.

## 11. Setup wizard

Setup MUST run safely on a Linux workstation, devcontainer, or project container. Setup SHOULD use
repo-native tooling and MUST NOT install host packages.

Setup MUST:

1. Read optional defaults from environment and existing config.
2. Ask for a Fizzy API token if one is not already provided.
3. Validate Fizzy access using the identity endpoint.
4. Let the user select a Fizzy account.
5. List boards visible to the selected account.
6. List account users and tags so setup can resolve bot assignees, tag IDs, and route validation
   inputs without guessing.
7. Detect account and board entropy settings and warn when auto-postpone behavior could interrupt
   long-running cards.
8. Detect Codex runner options as far as possible.
9. Explain any Codex authentication/configuration it cannot validate.
10. Ask for or infer watched board IDs.
11. Offer to create a recommended starter board.
12. Offer API-managed webhook setup when a public callback URL is configured, including create,
    update, and reactivate flows.
13. Validate every selected existing board/golden-ticket structure before writing a dispatch-ready
    config.
14. Generate a complete annotated config.
15. Fail loudly if selected board routes are unsafe.
16. Default the runner to `cli_app_server` unless an exact SDK runner is configured.
17. Default unattended approval/input behavior to reject, and require explicit operator selection for
    any high-trust auto-approval mode.

Setup MUST detect automatically when safe for the selected runner and selected boards:

- Fizzy API URL from environment or existing Fizzy CLI config.
- Fizzy token validity and accessible accounts.
- Account users and tags.
- Existing boards and columns.
- Existing native golden cards, `agent-instructions` tags, and completion tags.
- Managed webhook existence, subscribed actions, signing secret, delivery status, and active/inactive
  state when `webhook.manage` is true.
- Account and board auto-postpone/entropy periods.
- Available local `codex` executable.
- Whether `codex app-server` appears available.
- Whether a selected language runtime has the configured Codex SDK package installed.
- Whether the configured server/status port is available.
- Whether configured repository paths exist.
- Whether `WORKFLOW.md` exists in configured repositories.

Setup MAY skip a detection only when the check would mutate user state, require paid/model-consuming
work, or require credentials setup cannot inspect. Skipped checks MUST be listed in the setup output
with exact remediation.

Setup cannot fully guarantee:

- The user is logged in to Codex for all future daemon runs.
- The selected model is available to the user's Codex account.
- Long-running Codex app-server turns will succeed.
- External webhook delivery will reach a local machine behind NAT.
- Repository-specific validation commands will pass.
- Future board edits will remain safe.

Setup MUST explain these remaining manual steps when applicable:

- How to log in to Codex or configure API credentials.
- How to expose webhooks or rely on polling.
- How to add `WORKFLOW.md` to a repository.
- How to correct unsafe golden tickets.
- How to run the daemon inside a devcontainer/project container if the repo expects containerized
  tooling.
- What the selected Codex approval and sandbox policy allows or rejects.

Starter board defaults:

- Board: `Agent Playground: <repo-folder>`
- Agent column: `Ready for Agents`
- Completion column: `Done`
- Golden ticket title: `Repo Agent`
- Golden ticket native status: `golden: true`
- Golden ticket tags: `#agent-instructions`, `#codex`, `#move-to-done`
- Optional smoke-test card: placed in the agent column and processed only after daemon start

Setup-created starter boards MUST default `agent.max_concurrent` to `1` unless the user explicitly
chooses a higher value after seeing the isolation policy.

## 12. Golden-ticket model

A dispatch-valid golden ticket is a Fizzy card with native `golden: true` status and an
`#agent-instructions` tag. Popper-style tag-only instruction cards are not dispatch-valid in the
MVP.

Human-facing docs MAY include a leading `#`, but Fizzy API tag values are normalized without the
leading `#`. The implementation MUST normalize both forms before validation and MUST compare tags
case-insensitively after trimming surrounding whitespace.

### Required semantics

- MVP routing mode is `column_scoped`.
- One golden ticket is REQUIRED for each agent-enabled column.
- A column is agent-enabled only when exactly one effective route resolves for that column.
- A golden ticket is a route descriptor, not a workflow DSL or repository policy file.
- Golden-ticket cards MUST NOT be processed as work cards.
- A card tagged `agent-instructions` but not marked native golden MUST fail dispatch-ready
  validation with remediation to mark it golden.
- A native golden card without `agent-instructions` is not an agent route and MUST NOT enable a
  column.
- A golden ticket without an explicit valid completion policy MUST fail startup validation.
- Multiple golden tickets in one column MUST fail startup validation.
- Multiple effective routes for one source column MUST fail startup validation.
- Unknown managed agent tags MUST fail validation unless config explicitly marks unknown managed tags
  as warnings. Arbitrary non-agent Fizzy tags MUST NOT fail validation.

Managed agent tag families are:

- backend: `codex`, `backend-codex` only for MVP
- model: `model-<model-slug>`
- workspace: `workspace-<name>`
- persona: `persona-<persona-slug>`
- priority: `priority-1` through `priority-5`
- completion: `move-to-<column-slug>`, `close-on-complete`, `comment-once`, `no-repeat`
- rerun: `agent-rerun`
- scope: `agent-instructions`, `agent-board`

### Board-level golden tickets

Board-level golden tickets are reserved for a later extension. MVP implementations MUST reject any
golden ticket tagged `agent-board` or any `agent-instructions` card without a column. They MUST NOT
silently ignore board-level-looking tickets because silent ignores make routing unsafe.

### Single ticket with multiple transitions

A column-scoped golden ticket MUST define exactly one route: the route for the column containing the
ticket. A single ticket with multiple transitions is not part of MVP.

### Completion routing location

Completion routing lives on the effective route. The effective route is normally the column-scoped
golden ticket. Work-card completion override is allowed only when all are true:

- local config allows card completion overrides
- the route allows card completion overrides
- the card has exactly one valid completion override

Route metadata MAY be expressed through tags and, later, through structured metadata parsed from the
golden ticket body. MVP conformance only requires tags. If structured metadata is implemented, it
MUST produce the same normalized `Route` record as tag parsing and MUST use the same conflict rules.

MVP tag-based routes inherit `allowed_card_overrides` from board config. The default MVP route allows
only `priority` overrides. A golden ticket MAY allow additional card overrides only through a
structured route metadata schema that the implementation documents and validates. Tags alone MUST NOT
silently broaden the override policy.

### Precedence order

For every route field, effective value resolution MUST use this order:

1. Work card tags or structured card metadata, if the field is allowed to be overridden.
2. Golden-ticket tags or structured golden-ticket metadata.
3. Board/default config.
4. Local runtime defaults.

When multiple tags in the same precedence layer conflict, that layer MUST fail validation before
precedence is applied. A lower-precedence conflict MUST NOT be hidden by a higher-precedence override.
An allowed work-card override supersedes the golden-ticket/default value; it is not a
card/golden-ticket conflict. Same-layer conflicts and disallowed overrides are validation failures.

Equivalent aliases in the same layer are not conflicts if they resolve to the same canonical value.
For example, `codex` and `backend-codex` together resolve to backend `codex` and are valid. Different
canonical values in the same family are conflicts.

### Valid golden-ticket tags

The implementation MUST support these MVP golden-ticket tags:

- `agent-instructions`
- `codex` or `backend-codex`
- `workspace-<name>`
- `model-<model-slug>`
- `persona-<persona-slug>`
- `move-to-<column-slug>`
- `close-on-complete`
- `comment-once`
- `no-repeat`

The backend field has exactly one MVP canonical value: `codex`. Any non-Codex backend tag, including
tags inherited from Popper-style multi-backend setups, MUST fail validation rather than dispatch to a
generic command runner.

Completion tags map as follows:

- `move-to-<column-slug>` -> `completion.policy = move_to_column`
- `close-on-complete` -> `completion.policy = close`
- `comment-once` -> `completion.policy = comment_once`
- `no-repeat` is valid only with `comment-once` and is a no-op alias because `comment_once` is always
  no-repeat.

`move-to-<column-slug>` MUST resolve hyphens to spaces only after exact tag parsing. The resolved
column name MUST be matched case-insensitively against board columns during validation. Empty suffixes
MUST fail validation.

If multiple board columns normalize to the same completion slug, any `move-to-<column-slug>` that
matches that slug MUST fail validation because the target is ambiguous. A literal hyphen in a column
name is not representable by MVP tag syntax; operators MUST choose an unambiguous column name or a
future structured completion target.

Completion graph validation is REQUIRED at startup:

- `move_to_column` MUST fail validation when the target column is the same as the source
  agent-enabled column.
- A cycle of agent-enabled columns connected only by `move_to_column` completion policies MUST fail
  validation unless every route in the cycle records a no-repeat completion marker before the move.
- `comment_once` and `close` do not create column-routing edges.
- A completion target that disappears after startup MUST produce a completion-failure marker and MUST
  NOT re-run the agent solely to retry the move.

Route ID MUST be stable:

```text
route_id = "board:" + board_id + ":column:" + source_column_id + ":golden:" + golden_card_id
```

Route fingerprint MUST be a digest of route ID, golden-ticket card digest, backend, model, workspace
identity, persona, completion policy, allowed overrides, and rerun policy.

All route, card, workspace, proof, and marker digests MUST use canonical JSON serialization with:

- UTF-8 encoding.
- Object keys sorted lexicographically at every level.
- No insignificant whitespace.
- ISO 8601 timestamps normalized to UTC with millisecond precision when timestamps are included.
- SHA-256 as the hash algorithm, represented as `sha256:<hex>`.
- Short IDs formed from the first 12 lowercase hex characters unless a field explicitly says
  otherwise.

`card_digest(card, route)` MUST include card ID, card number, title, description, steps with checked
state, non-daemon tags, closed/postponed state, source column ID, route ID, route fingerprint, and
Fizzy `last_active_at` when available. It MUST exclude daemon-authored claim/completion/error tags
and daemon marker comments so the daemon does not change the digest by recording its own state.

Allowed card overrides are part of the route. Defaults are:

```yaml
allowed_card_overrides:
  backend: false
  model: false
  workspace: false
  persona: false
  priority: true
  completion: false
```

A recognized card override tag for a field that is not allowed by both board config and route policy
MUST fail routing with a visible card comment and status error. It MUST NOT be silently ignored.

Examples:

```text
Column-scoped route:
Golden ticket in "Ready for Agents"
Native golden: true
Tags: #agent-instructions #backend-codex #move-to-done
Result: cards in Ready for Agents use Codex and move to Done.

Disallowed card override:
Route allowed_card_overrides.backend = false
Work card tags: #backend-codex
Result: fail-validation comment, no dispatch.

Duplicate route:
Column has two #agent-instructions cards.
Result: startup validation fails; no cards dispatch from that board.
```

## 13. Card routing model

A work card is route-eligible only if all are true:

- It is not a golden ticket.
- It is on a watched board.
- It is in a column with exactly one effective route.
- It is not closed.
- It is not postponed, unless config explicitly allows postponed cards.
- It is not already claimed by a live unexpired claim.
- It is not already running in this daemon.
- It is not already completed under a no-repeat completion marker.
- It is not marked with an unresolved completion-policy failure marker for the current route
  fingerprint.
- Its routing tags are valid and non-conflicting.

Work cards MAY override:

- backend
- model
- workspace
- agent persona
- priority
- completion behavior

Completion behavior MUST NOT be overrideable by default. It MAY be enabled by local config and
golden-ticket route policy.

Supported card tag families:

- backend: `#codex` or `#backend-codex`
- model: `#model-<model-slug>`
- workspace: `#workspace-<name>`
- persona: `#persona-<name>`
- priority: `#priority-1` through `#priority-5`
- completion: `#complete-move-to-<column>`, `#complete-close`, `#complete-comment-once`
- rerun: `#agent-rerun`

Conflict rules:

- More than one backend canonical value on the same card MUST fail routing.
- More than one model canonical value on the same card MUST fail routing.
- More than one workspace canonical value on the same card MUST fail routing.
- More than one persona canonical value on the same card MUST fail routing.
- More than one priority canonical value on the same card MUST fail routing.
- More than one completion canonical value on the same card MUST fail routing.
- Unknown named workspace MUST fail routing.
- Unknown model MAY fail routing at setup if model validation is possible; otherwise it MUST fail
  at dispatch with a visible card comment and status error.
- Disallowed recognized override tags MUST fail routing.
- `agent-rerun` MUST be consumed or ignored only after the daemon records the rerun decision in local
  status. If Fizzy supports tag removal, successful rerun dispatch SHOULD remove the tag after claim
  acquisition; otherwise the no-repeat marker MUST record that the rerun signal was used.

Dispatch priority SHOULD sort by:

1. explicit card priority override
2. Fizzy card priority/order if available
3. oldest `last_active_at`
4. card number

## 14. Workspace model

Every card route MUST map to one deterministic isolated workspace identity. The identity MUST include
at least:

- board ID
- card ID and number
- workspace name
- canonical source repository path
- base ref or source snapshot ID
- isolation strategy

The workspace key MUST be derived from that identity:

```text
source_ref = source_snapshot_id if dirty_source_repo_policy == "snapshot" else base_ref
repo_key = short_digest(canonical_repo_path + "@" + source_ref)
workspace_key = sanitize("<board_id>-<workspace_name>-card-<card_number>-<card_id>-<repo_key>")
workspace_path = <workspace_root>/<workspace_key>
```

Sanitization MUST replace every character outside `[A-Za-z0-9._-]` with `_`.

Unknown named workspaces MUST fail routing. The implementation MUST NOT silently fall back from an
unknown named workspace to the default workspace.

Supported isolation strategies:

- `git_worktree`: create a per-card git worktree from a configured source repository and base ref.
- `git_clone`: create a per-card clone for repositories where worktrees are not suitable.
- `copy`: copy a prepared source tree when VCS metadata is unavailable.

The implementation MUST NOT use a shared repository working directory as an agent execution
workspace. A non-isolated mode MAY exist only for diagnostics and MUST be rejected when
`agent.max_concurrent > 1`.

Workspace metadata MUST be written before Codex starts:

- card ID and number
- board ID
- route ID
- route fingerprint
- instance ID
- run attempt ID
- workspace name
- workspace key
- source repository path
- canonical source repository path
- base ref or source snapshot
- isolation strategy
- daemon-owned guard file version
- created timestamp

If an existing workspace has metadata that does not match the current workspace identity, route
fingerprint, or canonical source repository, the daemon MUST preserve the existing workspace and fail
dispatch for that card until a human resolves the conflict or config explicitly requests a fresh
attempt in a new workspace key.

For git worktrees:

- The worktree path MUST be deterministic for the workspace identity and MUST use the configured
  `worktree_root` for the selected workspace registry entry.
- The branch name MUST be deterministic and include board/card/workspace identity, for example
  `fizzy/<board_id>-card-<number>-<short_card_id>-<workspace_name>-<short_workspace_identity_digest>`.
  Implementations MAY add a human board slug for readability, but stable IDs and the workspace
  identity digest are REQUIRED.
- Existing card worktrees MUST be reused unless config explicitly requests a fresh attempt.
- Dirty worktrees MUST NOT be removed silently.
- Source repositories MUST be validated before dispatch. If `require_clean_source` is true and the
  source repo is dirty, dispatch MUST fail before claim acquisition. If the policy is `snapshot`, the
  snapshot ID MUST be recorded in workspace metadata and included in the workspace key, route
  fingerprint input, and proof record.
- Worktree removal SHOULD use non-force removal. Force removal and raw recursive deletion are
  forbidden for normal cleanup. They MAY exist only as a separate operator command that requires
  explicit card/workspace identity and prints the proof and guard checks it is bypassing.

Workspace lifecycle hooks MAY exist, but they MUST run inside the card workspace and MUST be
declared in `WORKFLOW.md`, not hidden in the daemon.

## 15. WORKFLOW.md policy model

Each configured repository MUST contain `WORKFLOW.md` for dispatch unless local config explicitly
enables an operator-created fallback workflow for MVP testing. The daemon MUST NOT invent repository
policy silently.

Discovery order:

1. Explicit workspace config `workflow_path`.
2. `WORKFLOW.md` at the root of the resolved source repository.
3. `WORKFLOW.md` at the root of the prepared card workspace.

If no workflow file exists, dispatch MUST fail unless local config explicitly points to a fallback
workflow file. Setup SHOULD offer to create a starter `WORKFLOW.md`, but the daemon MUST not create
one without operator confirmation.

File format:

- OPTIONAL YAML front matter delimited by `---`.
- Markdown prompt body after front matter.
- Front matter MUST parse as a map/object.
- The body is the repo-specific policy prompt.

`WORKFLOW.md` is the authoritative execution policy for the repository. Golden-ticket text and work
card text are task inputs rendered into that policy; they MUST NOT override `WORKFLOW.md` rules for
validation, branch/PR behavior, rework, merge handling, filesystem boundaries, or cleanup safety.

Free-form Markdown conflicts are not mechanically knowable and MUST NOT be treated as a daemon
startup blocker. The daemon may only fail a workflow/card conflict before Codex starts when the
conflict is represented in a structured, documented schema field. If structured workflow conflict
classes are implemented, the spec for that implementation MUST define the exact front matter keys,
allowed values, comparison rules, and override permissions. Otherwise the daemon MUST render the
apparent conflict into the prompt/status for the agent and operator instead of inventing a validator.

`WORKFLOW.md` MAY define:

- validation commands
- branch naming policy
- commit/PR policy
- handoff rules
- allowed filesystem boundaries
- hooks: `after_create`, `before_run`, `after_run`, `before_remove`
- prompt template fragments

Prompt rendering MUST include:

- Fizzy board
- column
- golden-ticket route
- work card title, description, steps, tags, assignees, comments, URL
- attempt number
- workspace metadata
- completion policy

Unknown template variables SHOULD fail prompt rendering rather than produce partial prompts.

Workflow loading order MUST be deterministic:

1. Resolve route and workspace identity without filesystem mutation.
2. Acquire the board-native claim.
3. Prepare or reuse the workspace.
4. Load `WORKFLOW.md` from the explicit path, source repo, or prepared workspace.
5. Render the prompt and start the runner.

The daemon SHOULD watch or poll `WORKFLOW.md` for changes. Reload behavior MUST keep the last known
good workflow for active and future runs when a new version fails parsing or validation, and MUST
surface the reload error in `/status`. If no last known good workflow exists, dispatch MUST fail.

## 16. Codex runner model

All runner behavior MUST go through this SDK-shaped abstraction:

```text
Runner.detect(config) -> DetectionReport
Runner.validate(config, workspace) -> ValidationReport
Runner.health(config) -> RunnerHealthReport
Runner.startSession(workspace, policies, metadata) -> Session
Runner.startTurn(session, prompt, metadata) -> Turn
Runner.stream(turn, onEvent) -> TurnResult
Runner.cancel(turn, reason) -> CancelResult
Runner.stopSession(session) -> void
```

`DetectionReport` MUST include runner kind, selected implementation, fallback implementation,
executable path or SDK package, detected version when available, supported protocol/schema source,
auth evidence found, unavailable reason, and remediation.

`ValidationReport` MUST include runner kind, workspace path validated, launch argv or SDK package,
policy payload validation result, app-server handshake or SDK initialization result when safe, whether
a model-consuming smoke turn was skipped, errors, warnings, and remediation.

`RunnerHealthReport` MUST include runner kind, active implementation, fallback state, version or
package details, last check time, status (`ready`, `degraded`, `unavailable`), readiness effect,
failure code, failure message, auth/config evidence, and remediation.

`Session` MUST include session ID when available, thread ID, runner kind, process ID for app-server
fallback, workspace path, start timestamp, policy payloads, and owned-process flag.

`Turn` MUST include run ID, attempt number, turn ID, thread ID, started timestamp, prompt digest,
workspace path, cancellation token/handle, and runner metadata.

`CancelResult` MUST include success boolean, final status (`cancelled`, `timeout`, `failed`,
`unknown_ownership`), whether the turn was interrupted, whether the session was stopped, whether a
process was killed, failure code/message, and remediation.

Preferred runner implementation:

- `CodexSdkRunner` SHOULD be used only when the selected implementation language has an exact
  supported Codex SDK package and setup can validate that it is installed/configured.
- Until that package is selected, the MVP uses `CodexCliAppServerRunner` as the normal fallback
  implementation behind the same preferred SDK-shaped interface.

Fallback runner implementation:

- `CodexCliAppServerRunner` MUST be supported.
- It MUST launch the configured app-server argv in the card workspace without shell eval.
- It MUST initialize the app-server, start a thread, start turns, stream events, handle tool calls
  and approval/input-required events, and extract session identifiers.
- It MUST treat the targeted Codex app-server protocol or generated schema as the source of truth for
  message names and payload shapes. The minimum lifecycle is: launch process, initialize, start
  thread with workspace cwd and thread sandbox, start turn with workspace cwd and turn sandbox policy,
  stream events until a final result/error/cancel event, extract thread/turn IDs, then stop the
  session and owned process.
- It MUST map approval/input-required events to failure in unattended mode unless config explicitly
  enables interactive operation.
- It MUST redact raw events before persistence unless the event type is explicitly marked safe.

The fallback runner MUST follow the same behavioral contract as the SDK runner. Routing,
workspace, claim, completion, and observability code MUST NOT know which runner is active except
through runner metadata.

Normal operation MUST NOT use `codex exec`, prompt-in/stdout CLI execution, or generic command
backends as a substitute for the runner contract. CLI probing such as `codex --version` is allowed.
The only CLI runner fallback for normal operation is `codex app-server` behind this SDK-shaped
interface.

Runner health:

- Startup validation MUST run `Runner.detect`, `Runner.validate`, and one lightweight
  `Runner.health` check.
- Periodic health checks SHOULD run while the daemon is alive and MUST update `/status`.
- `/health` MAY stay live when runner health is degraded, but readiness MUST be false when the
  runner cannot dispatch new work safely.
Health probes MUST be non-mutating by default. They MAY check executable presence, version, SDK
package presence, app-server schema generation, app-server startup/initialize handshake in a temporary
empty workspace, auth file or environment evidence, and required config fields. A real model turn is
OPTIONAL and MUST be opt-in because it can consume quota and depend on account entitlement. `/ready`
MUST be false when executable/package detection fails, app-server handshake fails, required policies
cannot be encoded, or selected auth/config is known missing. Model entitlement unknowns MAY be
reported as `degraded` when no smoke turn was requested.

Run metadata schemas:

`RunMetadata` MUST include:

- run ID and attempt number
- card ID, card number, board ID, route ID, route fingerprint
- workspace identity and workspace path
- runner kind, SDK package or app-server command/version, model
- instance ID, claim ID, start timestamp

`RunnerEvent` MUST include:

- event type
- timestamp
- run ID and attempt number
- session/thread/turn IDs when available
- token/rate-limit metadata when available
- raw runner event reference when safe to persist

`TurnResult` MUST include:

- success boolean
- final status (`completed`, `failed`, `cancelled`, `preempted`, `timed_out`, `input_required`,
  `max_turns_reached`)
- session/thread/turn IDs
- output summary or final message when available
- proof references produced by the runner
- token/rate-limit metadata when available
- `RunnerError` when failed

`RunnerError` MUST include:

- normalized code
- message
- remediation
- retryable boolean
- raw error reference when safe to persist

`Runner.stream` MUST either return `TurnResult` or emit a final event containing the full
`TurnResult`. The runner interface MUST NOT require a separate undocumented `final_result` call.

Setup can detect:

- configured runner kind
- local SDK package presence when language tooling supports it
- local `codex` executable presence
- `codex --version`
- app-server command startup or generated schema when safe
- whether required runner config fields are present

Setup still requires the user for:

- Codex login or API credentials
- model access/entitlement
- approval policy choice
- sandbox policy choice
- any account-specific or organization-specific config

Failure surfacing:

- Setup runner failures MUST be printed with concrete remediation.
- Startup runner validation failures MUST stop the daemon.
- Dispatch-time runner failures MUST record run failure, post a Fizzy comment when possible, and
  expose failure in status.
- Approval/input-required events in unattended mode MUST fail the turn with a clear message unless
  config explicitly allows interactive operation.
- Generated unattended config MUST default to rejecting approval/input-required events. It MUST NOT
  use a Codex protocol value whose runtime meaning is auto-approval unless the operator explicitly
  chooses that high-trust mode during setup and the generated config documents the risk.

## 17. Event ingestion

The daemon MUST support both webhooks and polling.

Webhook ingestion:

- MUST expose `POST /webhook` when enabled.
- MUST verify `X-Webhook-Signature` when a secret is configured.
- SHOULD reject stale events using event timestamp tolerance.
- MUST deduplicate recent event IDs.
- SHOULD be managed by setup through Fizzy webhook APIs when `webhook.manage` is true: list existing
  webhooks, create or update the managed webhook, subscribe to required actions, persist the webhook
  ID, and reactivate inactive managed webhooks.
- MUST surface managed webhook delivery failures in status when the API exposes delivery history.
- MUST route card lifecycle events to spawn, cancel, refresh, or ignore decisions.
- MUST ignore self-authored daemon comments unless the card has an explicit rerun signal.
- MUST NOT start a runner directly. Spawn-like webhook events MUST enqueue or trigger the same
  claim-aware dispatch pipeline used by polling.

Webhook routing table:

| Event | Condition | Decision |
| --- | --- | --- |
| `card_triaged` | work card enters a column with exactly one effective route | enqueue spawn hint |
| `card_published` | work card is published in a routed column | enqueue spawn hint |
| `card_reopened` | work card is reopened in a routed column | enqueue spawn hint |
| `card_board_changed` | work card arrives on watched board in routed column | enqueue spawn hint |
| `card_board_changed` | active card leaves watched board | cancel active run |
| `card_closed` | active card closes | cancel active run |
| `card_postponed` | active card is postponed | cancel active run |
| `card_auto_postponed` | active card is auto-postponed | cancel active run |
| `card_sent_back_to_triage` | active card leaves routed column | cancel active run |
| `comment_created` | daemon-authored comment and no rerun signal | ignore |
| `comment_created` | human comment and card has explicit rerun signal | enqueue refresh/spawn hint |
| any event on `agent-instructions` card | golden ticket changed | refresh golden-ticket registry |
| any other event | no safe route change | ignore |

Every spawn hint MUST still pass polling-equivalent route validation, claim acquisition, workspace
resolution, and concurrency checks before dispatch.

Polling ingestion:

- MUST run an immediate poll at startup after validation.
- MUST repeat at `polling.interval_ms`.
- MUST suppress overlapping ticks.
- MUST refresh golden-ticket registry using native golden-card queries when API filters are enabled.
- MUST list watched-board cards using API filters when enabled, then run full local validation before
  dispatch.
- SHOULD use ETag/`If-None-Match` on repeated board, card, comment, golden-ticket, tag, user, and
  webhook reads. A `304 Not Modified` response MUST keep the prior normalized resource snapshot and
  skip expensive parsing for that resource.
- MUST treat ETag caches as an optimization only. Missing, expired, or invalid cache entries MUST
  fall back to full reads without changing route semantics.
- MUST store ETag cache metadata under `observability.state_dir` and invalidate it when Fizzy account,
  board, auth, or API URL configuration changes.
- MUST reconcile active claims and runs.
- MUST discover eligible cards even if webhooks are disabled or missed.

Webhook events are hints. Polling reconciliation is the correctness path.

## 18. Reconciliation loop

Each poll tick MUST:

1. Refresh runtime config when supported and refresh `WORKFLOW.md` with last-known-good semantics.
2. Refresh golden-ticket registry for watched boards.
3. Renew live claims for active runs.
4. Reconcile active runs against current card state.
5. Cancel runs for cards that left eligible columns or were closed/postponed.
6. Cancel or pause runs whose current route fingerprint differs from the claimed route fingerprint.
7. Detect stalled runner sessions.
8. Discover eligible cards.
9. Resolve routing for each candidate.
10. Skip cards with active unexpired claims from other instances.
11. Dispatch until concurrency slots are exhausted.
12. Emit a status snapshot.

The reconciler MUST NOT rely on in-memory `recent completions` as the only loop-prevention
mechanism. Loop prevention MUST be board-native or persisted in the local run registry.

## 19. Supervisor/runtime state

The supervisor owns in-memory runtime state for one daemon instance.

State MUST include:

- instance ID
- active runs by card ID
- active claims by card ID
- retry queue
- recent completions
- recent failures
- Codex session metadata
- token/rate-limit metadata when available
- workspace path and cleanup state for every run
- status endpoint URL

The supervisor MUST enforce:

- global concurrency limit
- per-card concurrency limit of 1
- optional per-board concurrency limit
- optional per-route concurrency limit
- maximum continuation turns per run

Active run cancellation MUST use explicit states:

- `cancel_requested`
- `runner_cancel_sent`
- `session_stopped`
- `claim_cancelled`
- `workspace_preserved`

Cancellation MUST interrupt the current runner turn. It MUST NOT wait for normal turn completion when
the card is closed, postponed, moved out of the route, route fingerprint changes, shutdown begins, or
the claim cannot be renewed. If `Runner.cancel` fails or times out, the supervisor MUST attempt
`Runner.stopSession`, then process termination for app-server fallback when the process is known to be
owned by this daemon. Unknown ownership MUST preserve workspace state and surface manual intervention.

Normal runner completion does not automatically mean the card is complete. Completion means:

1. runner finished successfully
2. proof/status was recorded
3. Fizzy report was posted
4. completion policy was applied or safely failed into a non-looping state

Proof schema:

- Durable proof MUST be a JSON file under `observability.state_dir/proof/`.
- It MUST include schema version, run ID, attempt ID, card ID/number, board ID, route ID, route
  fingerprint, card digest, workspace identity digest, runner kind, thread/turn IDs, final status,
  output summary, validation evidence when available, result comment ID, branch name, commit SHA, PR
  URL or explicit `no_code_change: true`, timestamps, and proof digest.
- `handoff` means the durable proof exists, Fizzy has a result comment or failure marker, and the
  route's completion policy has either succeeded or safely failed into a non-looping marker.
- A run may set `no_code_change: true` only when the result explicitly states no repository mutation
  was needed and workspace inspection confirms no local changes.

Agent workpad:

- When `workpad.enabled` is true, each claimed card MUST have one daemon-authored workpad comment for
  the current run series.
- The daemon MUST update that comment in place for live progress, current turn, retry state,
  validation evidence, and handoff summary instead of posting a new progress comment for every state
  transition.
- Claim, completion, and completion-failure markers MUST remain append-only and MUST NOT depend on
  the mutability of the workpad comment.
- The workpad body MUST be rich text compatible and MUST link to durable proof rather than embedding
  large logs. Direct-upload attachments are deferred from MVP.

Card steps:

- Work-card steps are acceptance/execution checklist input to the prompt.
- A route or `WORKFLOW.md` MAY mark unchecked steps as completion blockers. If it does, the daemon
  MUST refresh the card before applying completion policy and MUST NOT complete while required steps
  remain unchecked.
- Daemon-managed validation steps MAY be created or updated only when enabled by route or
  `WORKFLOW.md` policy. User-authored steps MUST NOT be deleted by the daemon.

Retries:

- Transient runner failures MAY retry with exponential backoff.
- Completion-policy failures SHOULD NOT retry the whole agent run by default because the work may
  already be done.
- Retrying a card MUST reuse the same deterministic workspace unless a fresh attempt is explicitly
  requested.
- Normal runner turn completion does not automatically complete the card. The daemon MUST refresh the
  card state after each turn. If the card remains active and the run has not reached `agent.max_turns`,
  the daemon SHOULD start a continuation turn on the same thread. If `agent.max_turns` is reached and
  the card is still active, the daemon MUST record that state and return control to reconciliation
  instead of applying completion policy blindly.

## 20. Completion policy

Every effective route MUST declare exactly one completion policy.

Valid policies:

- `move_to_column`: post result/proof, then move card to a named column.
- `close`: post result/proof, then close the card.
- `comment_once`: post result/proof, leave card in place, and record a no-repeat completion marker.

Popper's implicit `comment` default is not safe enough for `fizzy-symphony`. An omitted completion
policy MUST fail validation.

`comment_once` MUST prevent loops by recording a marker that polling can see. MVP marker storage is a
structured daemon comment plus a best-effort tag. The structured comment body MUST contain a fenced
JSON block headed by `fizzy-symphony:completion:v1`. The best-effort tag MUST be
`agent-completed-<short-route-id>`.

All daemon marker comments MUST use this Markdown wire format:

````text
<!-- fizzy-symphony-marker -->
fizzy-symphony:<marker-kind>:v1

```json
{ canonical JSON payload }
```
````

The plain-text heading MUST match the JSON `marker` field. The JSON payload MUST be valid canonical
JSON before posting. Parsers MUST ignore unrelated text outside the fenced JSON block, MUST treat
malformed daemon markers as status warnings, and MUST NOT treat malformed markers as valid claims or
completion proof. Marker payloads MUST NOT include secrets or raw runner event payloads unless those
payloads have been redacted according to runner policy.

The success marker MUST include:

- run ID
- route ID
- route fingerprint
- instance ID
- workspace key
- workspace identity digest
- completion timestamp
- card digest
- Fizzy result comment ID
- durable proof file path and proof digest

Example success marker payload:

```json
{
  "marker": "fizzy-symphony:completion:v1",
  "kind": "completion",
  "run_id": "run_123",
  "route_id": "board:board_123:column:col_ready:golden:card_gt",
  "route_fingerprint": "sha256:...",
  "instance_id": "host-a-main",
  "workspace_key": "board_123-app-card-42-card_abc-1a2b3c4d",
  "workspace_identity_digest": "sha256:...",
  "completed_at": "2026-04-29T12:00:00Z",
  "card_digest": "sha256:...",
  "fizzy_result_comment_id": "comment_123",
  "proof_file": ".fizzy-symphony/run/proof/run_123.json",
  "proof_digest": "sha256:..."
}
```

Proof and run status files MUST be stored outside the workspace cleanup target, normally under
`observability.state_dir`. A workspace-local proof copy MAY exist for human convenience, but cleanup
eligibility MUST rely only on the durable proof record outside the workspace and its digest.

A card with `comment_once` MAY be eligible again only if:

- a human adds `#agent-rerun`, or
- the card digest changed and the route explicitly allows rerun-on-change, or
- the no-repeat marker is removed by a human.

If `move_to_column` cannot find the target column, startup validation SHOULD have already failed.
If the column disappears after startup, completion MUST record a completion-policy failure, release
the claim, and mark the card non-looping with an error tag/comment.

Completion-policy failure marker:

- The structured comment heading MUST be `fizzy-symphony:completion-failed:v1`.
- The best-effort tag MUST be `agent-completion-failed-<short-route-id>`.
- The marker MUST include run ID, route ID, route fingerprint, instance ID, workspace key, failure
  reason, result comment ID when present, durable proof path/digest when present, and card digest.
- Route eligibility MUST treat this marker as non-looping for the same route fingerprint until a human
  adds `agent-rerun`, removes the marker/tag, or changes the card content under a route that
  explicitly allows rerun-on-change.
- If `agent-rerun` is used, the daemon MUST record that the rerun signal was consumed. If Fizzy
  supports tag removal, the daemon SHOULD remove `agent-rerun` after acquiring the new claim.

Example comment-once/no-repeat route:

```text
Golden ticket native status: golden: true
Golden ticket tags: #agent-instructions #backend-codex #comment-once
After success: post result, write fizzy-symphony:completion:v1 marker, leave card in place.
Next poll: ignore unless #agent-rerun is present or card digest changed under explicit rerun-on-change.
```

## 21. Port and instance coordination

Instance identity:

- Default instance ID SHOULD be a stable hash of absolute config path, watched board IDs, workspace
  root, and local hostname.
- Users MAY set `instance.id` explicitly.
- Instance ID MUST appear in logs, status snapshots, claim markers, and workspace metadata.

Port allocation:

- Fixed port with `port_allocation: fixed` MUST fail startup if unavailable.
- `port: auto` or `port_allocation: next_available` SHOULD scan from a configured base port and
  bind the first available port.
- Allocation MUST bind and hold the actual server listener. The daemon MUST write the actual bound
  host/port to the local instance registry only after the listener is active.
- The default bind host is `127.0.0.1`.
- Status and webhook endpoints share the same local HTTP server in MVP.

Status endpoint discovery:

- The daemon MUST write an instance file such as
  `.fizzy-symphony/run/instances/<instance-id>.json`.
- The file MUST contain instance ID, config path, PID, host, port, base URL, watched boards,
  workspace root, start time, and heartbeat timestamp.
- The file MUST be written atomically by writing to a temporary path and renaming into place.
- Heartbeat updates MUST run at `server.heartbeat_interval_ms`.
- Startup MUST remove stale instance files only after checking PID, host, heartbeat age, and config
  path. A same-instance-ID startup MUST fail if a live process owns the registry file.
- The status CLI MUST read this registry before falling back to default `127.0.0.1:<port>`. If
  multiple live instances exist, it MUST show all matches unless the user selects an instance ID.

Lock/claim behavior:

- Local file locks MAY prevent two daemons using the same config path.
- Board-native claims MUST prevent two different local configs from working the same card.
- Claims MUST have leases and renewal.
- A daemon MAY steal an expired claim only after recording the previous claim metadata in status.
- A daemon MUST NOT steal a non-expired claim from another live instance.

MVP claim protocol:

1. Resolve route, route fingerprint, and workspace identity without mutating the workspace.
2. Read the card comments and tags for `fizzy-symphony:claim:v1` records.
3. Reduce the append-only claim log by grouping records by `claim_id`, sorting by Fizzy comment
   timestamp, marker sequence if present, then claim ID, and keeping the latest valid status per
   claim.
4. Terminal statuses `released`, `completed`, `failed`, `cancelled`, and `lost` MUST stop that claim
   ID from blocking dispatch.
5. If any non-expired live claim exists for the same card ID, skip dispatch regardless of route
   fingerprint. Route changes are handled through cancellation/preemption, not by starting a second
   claim.
6. If only expired claims exist, wait `claims.steal_grace_ms`, re-read, then steal only if still
   expired.
7. Post a structured claim comment containing claim ID, instance ID, card ID, board ID, card digest,
   route ID, route fingerprint, workspace identity digest, attempt ID, run ID, `started_at`,
   `renewed_at`, `expires_at`, and status `claimed`.
8. Re-read comments and reduce the log again. The winning claim is the earliest non-expired live
   claim by `(started_at, claim_id)` after allowing for `claims.max_clock_skew_ms`. Losing daemons
   MUST post a best-effort `lost` claim marker, write local lost-claim status, and MUST NOT prepare
   the workspace or start Codex.
9. Renew by posting a new structured claim comment with the same claim ID and a later
   `renewed_at`/`expires_at`. MVP implementations MUST use append-only renewal comments because the
   reference Fizzy surface only requires comment creation. If renewal fails past expiry, the daemon
   MUST cancel the run and preserve the workspace.
10. Release by posting a structured claim status `released`, `completed`, `failed`, or `cancelled`.
    Release failure MUST be visible in status, MUST block cleanup, and MUST preserve the workspace.

Example claim marker comment:

```json
{
  "marker": "fizzy-symphony:claim:v1",
  "claim_id": "claim_123",
  "status": "claimed",
  "instance_id": "host-a-main",
  "card_id": "card_abc",
  "board_id": "board_123",
  "card_digest": "sha256:...",
  "route_id": "board:board_123:column:col_ready:golden:card_gt",
  "route_fingerprint": "sha256:...",
  "workspace_identity_digest": "sha256:...",
  "attempt_id": "attempt_1",
  "run_id": "run_123",
  "started_at": "2026-04-29T12:00:00Z",
  "renewed_at": "2026-04-29T12:05:00Z",
  "expires_at": "2026-04-29T12:20:00Z"
}
```

Restart and shutdown lifecycle:

- On SIGINT/SIGTERM, the daemon MUST stop accepting webhooks, stop scheduling new dispatch, request
  cancellation for active runner turns, write local shutdown status, release or mark claims as
  `cancelled` when possible, preserve workspaces, and remove only its live instance registry file.
- On startup, before the first poll, the daemon MUST read the local run registry, workspace metadata,
  claim comments for watched boards, and instance registry files.
- Interrupted local attempts MUST be marked `interrupted` in status. Their workspaces MUST be
  preserved until proof/handoff cleanup checks pass.
- Expired claims from dead instances MAY be stolen only through the claim protocol above.
- Non-expired claims from live instances MUST be skipped.
- Orphaned runner processes that can be confidently identified as owned by this daemon instance MUST
  be cancelled. If ownership is uncertain, the daemon MUST preserve workspace state and surface a
  manual intervention warning.

Authoritative startup order:

1. Parse config strictly and resolve environment references.
2. Resolve instance ID and instance registry path.
3. Inspect instance registry files; remove only confirmed stale files.
4. Fail startup if the same instance ID is owned by a live process.
5. Bind or allocate the HTTP listener and hold it.
6. Atomically write this process's instance registry file with PID, process start time when available,
   hostname, container/runtime namespace identity when available, bound endpoint, config path, and
   heartbeat timestamp.
7. Start heartbeat updates.
8. Run startup validation.
9. Run startup recovery.
10. Set readiness true only when validation and recovery allow dispatch.
11. Start webhook intake and the immediate polling tick.

If startup fails after the listener or registry file is created, the daemon MUST close the listener,
stop heartbeat updates, remove only the registry file owned by this process, write a failure snapshot
when possible, and MUST NOT dispatch work. If liveness is uncertain because PID/hostname/container
identity cannot prove ownership, the daemon MUST preserve the registry file until heartbeat expiry and
surface a warning.

## 22. Status and observability

The daemon MUST expose:

- `GET /health`
- `GET /ready`
- `GET /status`
- `GET /status/cards/:card_id` or equivalent card/run lookup

`/health` is process liveness. `/ready` is dispatch readiness and MUST be false when startup
validation, Fizzy access, claim storage, workspace safety, or runner health is unsafe.

`/status` MUST include:

- instance ID and label
- process ID
- bound host/port
- watched boards
- poll interval
- webhook enabled/disabled
- managed webhook status and recent delivery errors when available
- ETag cache hit/miss/invalid counters
- runner kind
- runner health
- active runs
- claims
- workpad comment IDs and last update timestamps
- retry queue
- recent completions
- recent failures
- workspace paths
- Codex session/thread/turn IDs when available
- token/rate-limit metadata when available
- last poll time and last error
- validation warnings/errors

Logs MUST be structured. Human-readable terminal output MAY be layered on top of structured logs.

The daemon SHOULD write a status snapshot to local disk so an operator can inspect the latest state
even if the HTTP server is unreachable.

Local run registry:

- MUST live under `observability.state_dir/runs/`.
- MUST write one JSON record per run attempt, atomically through temp-file rename.
- MUST include schema version, run ID, attempt ID, card ID/number, board ID, route ID, route
  fingerprint, card digest, workspace identity digest, workspace path, claim ID, runner kind,
  thread/turn IDs, status, timestamps, proof path/digest, result comment ID, cleanup state, and last
  error.
- MUST record transitions before external side effects when possible: `claiming`, `claimed`,
  `preparing_workspace`, `running`, `preempted`, `completed`, `failed`, `cancelled`,
  `cleanup_started`, `cleanup_completed`, `cleanup_preserved`.
- On restart, board claim comments are authoritative for cross-instance ownership, workspace metadata
  is authoritative for filesystem identity, and the local run registry is authoritative for this
  daemon's interrupted attempts and cleanup recovery. Disagreements MUST preserve workspaces and
  require claim revalidation before any new dispatch.

## 23. Startup validation

Startup validation MUST run before webhook and poll loops begin.

Validation MUST check:

- config file exists and parses
- config contains no unknown keys outside documented extension maps
- required secrets resolve
- Fizzy API identity works
- configured bot user exists when assignment/watch features require it
- watched boards exist
- account users and tags can be listed when setup/startup needs ID resolution
- managed webhook configuration is valid when `webhook.manage` is true
- board/account entropy settings are known or explicitly skipped with a warning
- configured columns referenced by completion policies exist
- golden-ticket discovery is unambiguous
- golden-ticket cards are native golden cards and tagged `agent-instructions`
- every agent-enabled route has explicit completion policy
- duplicate golden tickets are rejected
- same-layer tag conflicts and disallowed overrides are rejected
- board-level golden tickets are rejected in MVP
- completion graph contains no unsafe same-column or cyclic move routes
- route IDs and route fingerprints are stable
- managed tag normalization and unknown managed tag policy are valid
- configured workspace roots are inside allowed paths
- source repositories exist
- `WORKFLOW.md` exists or explicit fallback is configured
- status/server port can bind or auto-allocation is enabled
- instance registry can be written
- claim mode is supported
- claim marker schema is supported
- preferred Codex runner can validate, or app-server runner can validate
- runner health check is ready or startup is explicitly in no-dispatch diagnostic mode
- safety cleanup policy is valid
- durable proof/status storage is outside cleanup targets
- board, route, and workspace concurrency limits are valid

Unsafe startup MUST fail loudly with an actionable message. The daemon MUST NOT start in a degraded
mode that can process cards unsafely.

## 24. Safety rules

- The daemon MUST run Codex only inside the resolved per-card workspace.
- The daemon MUST validate workspace path containment before runner start.
- The daemon MUST NOT delete a workspace before proof metadata is persisted.
- Dirty worktrees MUST NOT be silently removed.
- Cleanup MUST preserve state when branch, commit, PR, result comment, or proof metadata is
  missing.
- Cleanup MUST preserve state when the durable proof/status record is inside the workspace cleanup
  target instead of `observability.state_dir` or another non-cleanup root.
- Cleanup MUST preserve state when terminal claim persistence failed or cannot be verified.
- Cleanup MUST preserve state when any local commit is unpushed, any branch is unmerged, any
  untracked file exists, or the daemon-owned guard file is missing.
- Cleanup MUST preserve state when workspace metadata does not match the current card, route
  fingerprint, workspace identity, or canonical source repository.
- A clean git status alone is not sufficient cleanup proof.
- Setup MUST NOT install host packages or mutate the host OS.
- Generated commands and docs SHOULD be zsh-friendly and Linux-first.
- Secrets MUST NOT be written into `WORKFLOW.md`.
- Runner sandbox and approval policies MUST be explicit in generated config.
- Webhook signature verification SHOULD be enabled for public webhooks.
- Self-authored daemon events MUST NOT retrigger work unless explicitly requested.
- Completion-policy failure MUST NOT create an infinite re-run loop.
- `card_auto_postponed` MUST be treated as a cancellation/release signal for active runs, not as a
  successful handoff.

Cleanup eligibility matrix:

| Condition | Required outcome |
| --- | --- |
| daemon-owned guard missing | preserve |
| workspace path outside allowed root after canonicalization | preserve and error |
| metadata mismatch for card/route/workspace/repo | preserve and error |
| proof file missing | preserve |
| durable proof outside cleanup target missing | preserve |
| Fizzy result comment ID missing | preserve |
| claim release/completion marker missing or release failed | preserve |
| branch/commit/PR missing and result is not explicitly no-code | preserve |
| dirty or untracked files exist | preserve |
| local commits are unpushed or branch is unmerged | preserve |
| completion policy failed | preserve |
| cleanup policy is `preserve` | preserve |
| cleanup policy is `remove_clean_only` and every check passes | remove with non-force removal |
| cleanup policy is `archive_after_retention` and retention has not elapsed | preserve |

Force removal and raw recursive deletion MUST NOT be used for normal cleanup. They MAY exist only as a
separate operator command that requires explicit card/workspace identity and prints the proof and
guard checks it is bypassing.

Cleanup MUST be transactionally recorded in local status before mutation. Cleanup states are:
`cleanup_planned`, `cleanup_started`, `archive_started`, `cleanup_completed`, `cleanup_failed`, and
`cleanup_preserved`. Startup recovery MUST inspect these states. If a daemon crashed during
`cleanup_started` or `archive_started`, the next startup MUST verify the durable proof record,
workspace metadata, and remaining filesystem state before resuming or marking manual intervention.

## 25. Reference algorithms

### setup

```text
function setup():
  defaults = read_env_and_existing_config()
  fizzy = prompt_for_fizzy_settings(defaults)
  identity = fizzy.get_identity()
  if identity fails: exit_with_error("Fizzy token invalid")

  account = select_account(identity.accounts)
  boards = fizzy.list_boards(account)
  users = fizzy.list_users(account)
  tags = fizzy.list_tags(account)
  entropy = fizzy.get_account_and_board_entropy(account, boards)
  bot_user = select_or_skip_bot_user(users)
  resolve_agent_tag_ids(tags)
  warn_about_entropy_if_needed(entropy)

  runner_report = detect_codex_runners()
  explain_runner_limits(runner_report)

  mode = prompt("create starter board, validate existing board, customize starter board")
  if mode creates board:
    board_plan = build_starter_board_plan()
    created = create_board_columns_golden_ticket_and_optional_smoke_card(board_plan)
    watched_boards = [created.board_id]
  else:
    watched_boards = select_boards(boards)
    validate_existing_board_shape(watched_boards)

  config = build_complete_annotated_config(fizzy, account, watched_boards, runner_report)
  if config.webhook.manage:
    manage_board_webhooks(config.webhook, watched_boards)
  validation = run_startup_validation(config, setup_mode=true)
  if validation.dispatch_safe:
    write_config(config)
  else if user_requests_diagnostic_config:
    write_config(config with diagnostics.no_dispatch=true)
  else:
    exit_with_error(validation.errors)
  print_remaining_manual_steps(runner_report)
```

### startup validation

```text
function startup_validation(config):
  parse_and_typecheck(config)
  resolve_required_env_values(config)
  validate_instance_registry(config)
  listener = bind_or_allocate_server_listener(config.server)
  fizzy.validate_identity()
  validate_bot_user_if_configured(config.fizzy.bot_user_id)
  validate_managed_webhooks_if_enabled(config.webhook)
  boards = fizzy.fetch_watched_boards(config.boards)
  tags = fizzy.list_tags_for_route_resolution()
  users = fizzy.list_users_if_needed()
  validate_entropy_visibility(boards)
  routes = discover_golden_tickets(boards)
  validate_routes(routes, boards.columns)
  validate_workspaces(config.workspaces)
  validate_workflow_files(config.workspaces)
  validate_claim_schema(config.claims)
  validate_safety_policy(config.safety)
  validate_runner(config.runner)
  runner_health = runner.health(config.runner)
  if runner_health.status != "ready" and not config.diagnostics.no_dispatch:
    fail("runner not ready")
  return ValidationOk(routes, listener, runner_health)
```

### golden-ticket discovery

```text
function discover_golden_tickets(boards):
  routes = []
  for board in boards:
    agent_tag = resolve_tag_id("agent-instructions")
    tagged_agent_cards = fizzy.list_cards(board_ids=[board.id], tag_ids=[agent_tag])
    for tagged in tagged_agent_cards:
      if not tagged.golden:
        fail("agent-instructions card must be marked native golden")

    golden_cards = fizzy.list_cards(board_ids=[board.id], indexed_by="golden")
    golden_cards = filter(golden_cards, has_tag("agent-instructions"))
    for golden in golden_cards:
      if is_board_level(golden) or golden.column missing:
        fail("board-level golden tickets are not supported in MVP")
      routes += [parse_column_route(golden.column, golden)]

  grouped = group_by(board_id, source_column_id, routes)
  for group in grouped:
    if group.count != 1: fail("ambiguous golden-ticket route")
  for route in routes:
    validate_completion_policy(route)
  validate_completion_graph(routes)
  return routes
```

### startup recovery

```text
function startup_recovery(config, routes):
  stale_instances = inspect_instance_registry(config.server.registry_dir)
  remove_confirmed_stale_instance_files(stale_instances)

  attempts = read_local_run_registry(config.observability.state_dir)
  workspaces = read_workspace_metadata(config.workspaces.metadata_root)
  claims = read_claim_markers_for_watched_boards(config.boards)

  for attempt in attempts where attempt.status in ["running", "claiming", "preparing", "preparing_workspace"]:
    mark_attempt_interrupted(attempt)
    preserve_workspace(attempt.workspace, "interrupted during previous daemon run")

  for attempt in attempts where attempt.cleanup_state in ["cleanup_started", "archive_started"]:
    verify_durable_proof_and_workspace_state(attempt)
    if verification_safe_to_resume_cleanup(attempt):
      mark_cleanup_recoverable(attempt)
    else:
      preserve_workspace(attempt.workspace, "cleanup interrupted; manual intervention required")

  for workspace in workspaces:
    if metadata_mismatch_or_guard_missing(workspace):
      mark_workspace_preserved(workspace, "metadata mismatch or missing guard")

  for claim in claims:
    if claim.instance_id == config.instance.id and claim.status == "claimed":
      if claim.expired:
        record_recoverable_expired_claim(claim)
      else:
        record_live_self_claim_warning(claim)

  return RecoveryReport(stale_instances, interrupted_attempts, preserved_workspaces, claims)
```

### server port allocation

```text
function bind_or_allocate_server_listener(server_config):
  if server_config.port is integer and allocation == fixed:
    return bind_or_fail(server_config.host, server_config.port)
  if server_config.port is integer and allocation == next_available:
    return bind_first_available_from(server_config.host, server_config.port)
  if server_config.port == auto:
    return bind_first_available_from(server_config.host, server_config.base_port)
  if allocation == random:
    return bind_port_zero(server_config.host)
```

### poll tick

```text
function poll_tick():
  if tick_in_progress: return
  tick_in_progress = true
  try:
    reload_config_if_supported()
    refresh_workflow_last_known_good()
    routes = refresh_golden_ticket_registry()
    renew_live_claims()
    reconcile_active_runs(routes)
    candidates = discover_candidate_cards_with_api_filters_and_etags(routes)
    for card in sort_by_priority(candidates):
      if supervisor.at_capacity(): break
      decision = resolve_card_routing(card, routes)
      if decision.spawn:
        workspace = resolve_workspace(card, decision.route)
        claim = acquire_claim(card, decision.route, workspace)
        if claim.acquired:
          dispatch_card(card, decision.route, workspace, claim)
  finally:
    emit_status_snapshot()
    tick_in_progress = false
```

### webhook dispatch

```text
function webhook_dispatch(request):
  raw_body = request.body
  if secret_configured:
    verify_signature_or_401(raw_body, request.headers)
    verify_fresh_timestamp_or_400(request.headers)
  event = parse_json_or_400(raw_body)
  if event_id_seen(event.id): return 200 duplicate
  remember_event_id(event.id)

  if event_from_this_daemon(event) and not explicit_rerun(event):
    return 200 ignored

  action = router.route_event(event)
  match action:
    refresh: refresh_golden_ticket_registry()
    cancel: supervisor.cancel(action.card_id, action.reason)
    spawn: enqueue_for_claim_aware_dispatch(action.card)
    ignore: noop
```

### card routing

```text
function resolve_card_routing(card, routes):
  if is_golden_ticket(card): return ignore
  if card.closed: return ignore
  if card.postponed and not config.routing.allow_postponed_cards: return ignore
  route = route_for(card.board_id, card.column_id)
  if route missing: return ignore
  if has_live_claim(card): return ignore
  if no_repeat_marker_exists(card, route) and not rerun_requested(card):
    return ignore
  if completion_failure_marker_exists(card, route) and not rerun_requested(card):
    return ignore

  parsed_layers = parse_and_validate_tag_layers(card, route.golden_ticket, config)
  if parsed_layers.has_same_layer_conflict:
    return fail_validation(parsed_layers.conflict_reason)

  values = {}
  for field in route_fields:
    if parsed_layers.card_override(field) and not route.allowed_card_overrides[field]:
      return fail_validation("card override not allowed")
    values[field] = resolve_precedence(
      parsed_layers.card_override(field),
      parsed_layers.golden_ticket_value(field),
      board_default(field),
      runtime_default(field)
    )
  return spawn(card, route.with(values))
```

### workspace resolution

```text
function resolve_workspace(card, route):
  workspace_name = route.workspace
  registry_entry = config.workspaces.registry[workspace_name]
  if registry_entry missing: fail("unknown workspace")
  canonical_repo = canonicalize(registry_entry.repo)
  source_ref = source_snapshot_id_if_snapshot_policy_else(registry_entry.base_ref)
  repo_key = short_digest(canonical_repo + "@" + source_ref)
  key = sanitize(board_id + "-" + workspace_name + "-card-" + card.number + "-" + card.id + "-" + repo_key)
  root = registry_entry.worktree_root or config.workspaces.root
  path = join(root, key)
  assert_path_inside_root(path, root)
  assert_path_inside_allowed_roots(path, config.safety.allowed_roots)
  identity = build_workspace_identity(card, route, registry_entry, canonical_repo, key)
  metadata = build_workspace_metadata(card, route, identity, path)
  if existing_metadata_mismatch(path, metadata): fail_preserve("workspace metadata mismatch")
  return Workspace(path, registry_entry, metadata)
```

### claim acquisition

```text
function acquire_claim(card, route, workspace):
  existing = reduce_claim_log(read_claim_markers(card))
  live = filter(existing, marker.card_id == card.id and is_live_claim(marker) and not expired(marker))
  if any(live): return ClaimResult(skipped, live_claim=oldest_by_started_at(live))

  expired = filter(existing, marker.card_id == card.id and is_live_claim(marker) and expired(marker))
  if any(expired):
    sleep(config.claims.steal_grace_ms)
    reread = reduce_claim_log(read_claim_markers(card))
    if any(reread, marker.card_id == card.id and is_live_claim(marker) and not expired(marker)):
      return ClaimResult(skipped)

  marker = build_claim_marker(card, route, workspace)
  fizzy.post_structured_comment(card, marker)
  reread = reduce_claim_log(read_claim_markers(card))
  winner = earliest_non_expired_live_claim(reread, config.claims.max_clock_skew_ms)
  if winner.claim_id != marker.claim_id:
    record_lost_claim(marker, winner)
    post_claim_status(marker, "lost")
    return ClaimResult(skipped, live_claim=winner)
  if config.claims.assign_on_claim:
    fizzy.assign_card(card, config.fizzy.bot_user_id)
  if config.claims.watch_on_claim:
    fizzy.watch_card(card)
  ensure_or_update_agent_workpad(card, marker, "claimed")
  return ClaimResult(acquired, claim=marker)
```

### WORKFLOW.md loading

```text
function load_workflow(workspace):
  path = first_existing([
    workspace.config.workflow_path,
    join(workspace.source_repo, "WORKFLOW.md"),
    join(workspace.path, "WORKFLOW.md")
  ])
  if path missing and not config.workflow.fallback_enabled:
    fail("WORKFLOW.md missing")
  content = read(path)
  front_matter, body = parse_markdown_with_optional_yaml(content)
  if front_matter is not map: fail("workflow front matter must be a map")
  return Workflow(front_matter, trim(body))
```

### workspace preparation

```text
function prepare_workspace(workspace):
  assert_path_inside_root(workspace.path, workspace.root)
  assert_path_inside_allowed_roots(workspace.path, config.safety.allowed_roots)
  if existing_metadata_mismatch(workspace.path, workspace.metadata):
    fail_preserve("workspace metadata mismatch")

  if workspace.exists and workspace.metadata_matches:
    if workspace_has_dirty_changes(workspace.path):
      if local_run_registry_has_interrupted_attempt_for(workspace.identity):
        return reuse_existing_workspace("resume interrupted attempt")
      fail_preserve("dirty matching workspace requires operator decision")
    return reuse_existing_workspace("clean matching workspace")

  if workspace.isolation == "git_worktree":
    validate_source_repo_clean_or_snapshot(workspace.source_repo)
    branch = deterministic_branch_name(workspace.identity)
    if branch_exists_with_different_identity(branch, workspace.identity):
      fail_preserve("branch identity collision")
    create_or_reuse_branch_from_base_ref(branch, workspace.base_ref)
    create_git_worktree(workspace.path, branch)
  else if workspace.isolation == "git_clone":
    clone_repo_at_ref(workspace.source_repo, workspace.path, workspace.base_ref)
  else if workspace.isolation == "copy":
    copy_source_tree(workspace.source_repo, workspace.path)

  write_guard_file(workspace.path)
  write_workspace_metadata(workspace.metadata_root, workspace.metadata)
  verify_workflow_path_if_configured(workspace)
  return workspace
```

### Codex dispatch

```text
function dispatch_card(card, route, workspace, claim):
  prepare_workspace(workspace)
  workflow = load_workflow(workspace)
  prompt = render_prompt(workflow, card, route, workspace, claim)
  runner = runner_factory(config.runner)
  session = runner.startSession(workspace.path, sandbox_policy(workspace), metadata)
  result = run_turns_until_done_or_max_turns(runner, session, prompt, card, route, claim)
  handle_completion(card, route, workspace, claim, result)
```

```text
function run_turns_until_done_or_max_turns(runner, session, prompt, card, route, claim):
  current_prompt = prompt
  for turn_number in 1..config.agent.max_turns:
    turn = runner.startTurn(session, current_prompt, metadata)
    result = runner.stream(turn, update_run_status)
    renew_claim_if_needed(claim)
    if not result.success: return result
    refreshed = fizzy.get_card(card.number)
    if card_no_longer_eligible_or_route_changed(refreshed, route):
      return TurnResult(success=false, status="preempted", retryable=false)
    current_prompt = continuation_prompt(refreshed, turn_number + 1)
  return TurnResult(success=false, status="max_turns_reached", retryable=true)
```

### completion handling

```text
function handle_completion(card, route, workspace, claim, result):
  record_local_run_result(card, route, workspace, result)
  update_agent_workpad(card, result)
  if result.success:
    refreshed = fizzy.get_card(card.number)
    if required_steps_unchecked(refreshed, route):
      record_completion_failure_marker(card, route, result, null, "required steps remain unchecked")
      release_or_retry_claim(claim, result with retryable=false)
      preserve_workspace(workspace, "required steps remain unchecked")
      return
    result_comment = post_fizzy_result_comment(card, result)
    record_proof_file(card, route, workspace, result, result_comment)
    completion_result = apply_completion_policy(card, route.completion)
    if completion_result.success:
      record_no_repeat_marker_if_needed(card, route, result, result_comment)
    else:
      record_completion_failure_marker(card, route, result, result_comment, completion_result.error)
    release = release_claim(claim)
    if release.success:
      safe_cleanup(workspace, result)
    else:
      preserve_workspace(workspace, "claim release failed")
  else:
    if result.status == "preempted":
      post_preempted_status(card, route, result)
      release_claim_as_cancelled(claim)
      preserve_workspace(workspace, "card moved or route changed during run")
    else:
      post_fizzy_error_comment(card, result.error)
      tag_error_best_effort(card)
      release_or_retry_claim(claim, result)
```

### loop prevention

```text
function no_repeat_marker_exists(card, route):
  markers = read_structured_daemon_comments_and_tags(card)
  current_digest = card_digest(card, route)
  for marker in markers:
    if marker.kind == "completion" and marker.route_id == route.id and marker.card_digest == current_digest:
      return true
    if marker.kind == "completion-failed" and marker.route_fingerprint == route.fingerprint:
      return true
  return false

function eligible_after_completion(card, route):
  if has_tag(card, "agent-rerun"): return true
  if route.allows_rerun_on_change and card_digest_changed(card, route): return true
  return not no_repeat_marker_exists(card, route)
```

### safe cleanup

```text
function safe_cleanup(workspace, result):
  if config.safety.cleanup.policy == preserve:
    return preserve
  status = inspect_workspace(workspace)
  if not cleanup_eligibility_checks_pass(workspace, result, status):
    mark_workspace_preserved(workspace, status.preservation_reason)
    return preserve
  if config.safety.cleanup.policy == remove_clean_only:
    remove_workspace_non_force(workspace)
  else if config.safety.cleanup.policy == archive_after_retention and retention_elapsed(workspace):
    archive_workspace(workspace)
  else:
    preserve_workspace(workspace)
```

### status snapshot

```text
function status_snapshot():
  return {
    instance,
    pid,
    endpoint,
    watched_boards,
    managed_webhooks,
    etag_cache,
    runner,
    runner_health,
    readiness,
    poll_state,
    active_runs,
    claims,
    workpads,
    retry_queue,
    recent_completions,
    recent_failures,
    validation_errors,
    workspace_cleanup_state,
    last_updated_at
  }
```

## 26. Implementation phases

Phase 0: Runtime spike

- Select the implementation runtime and update `docs/runtime-decision.md`.
- Confirm selected-runtime package, build, and local install shape.
- Confirm CLI app-server runner can start, initialize, run a harmless turn, stream events, cancel,
  handle input-required events, and report errors through the SDK-shaped contract.
- Confirm Codex SDK availability only as an optional runner unless the selected runtime has a stable
  SDK package and contract.
- Build fake Codex runner contract tests before real runner integration.

Phase 1: Config, setup, and validation

- Implement annotated config generation.
- Implement Fizzy identity/board validation.
- Implement users/tags listing, tag ID resolution, entropy warnings, and optional webhook
  create/update/reactivate setup.
- Implement native-golden plus `agent-instructions` golden-ticket discovery and validation.
- Implement runner detection.
- Implement strict config parsing and marker/comment parser fixtures.
- Implement startup validation tests for unsafe config, duplicate routes, missing completion policy,
  missing `WORKFLOW.md`, missing runner, and unsafe cleanup policy.

Phase 2: Workspace and claim foundation

- Implement deterministic per-card workspace manager.
- Implement git worktree preparation and preservation.
- Implement board-native claim leases and local instance registry.
- Implement local run registry and durable proof/status paths before real runner integration.
- Implement startup recovery for interrupted runs, stale instance registry files, expired claims, and
  preserved workspaces.
- Add tests for workspace isolation, metadata mismatch, symlink escape, dirty worktree preservation,
  claim contention, expired claim stealing, non-expired claim skipping, renewal failure, and crash
  recovery.

Phase 3: Reconciler and router

- Implement polling loop.
- Implement API-filtered and ETag-aware polling.
- Implement webhook server as enqueue-only dispatch hints.
- Implement routing precedence and card override validation.
- Implement loop-prevention markers.
- Implement completion-failure marker parsing before enabling dispatch from routed columns.
- Add tests for normalized tags, route IDs, route fingerprints, disallowed overrides, unknown
  managed tags, rerun tags, self-authored events, card moved while running, and webhook/poll
  duplicate delivery.

Phase 4: Codex runner and supervisor

- Implement SDK-shaped runner interface.
- Implement CLI app-server runner.
- Implement SDK runner only if an exact SDK target has been selected.
- Implement active run status, stall detection, retry behavior, and cancellation.
- Add tests for runner health, metadata extraction, approval/input-required failure, timeout,
  cancellation, and same-thread continuation.

Phase 5: Completion and cleanup

- Implement completion policies.
- Implement proof recording.
- Implement single-comment agent workpad updates and step-gated completion when configured.
- Implement safe cleanup guards.
- Implement status endpoint and status CLI.
- Add tests for `move_to_column`, `close`, `comment_once`, completion-policy failure markers,
  workpad replacement on update failure, required unchecked steps, cleanup preservation, clean-only
  cleanup, and status snapshots.

Phase 6: Hardening

- Add real Fizzy smoke tests where credentials are available.
- Add real Codex app-server smoke tests where local auth is available.
- Add longer-running soak tests for multi-card concurrency and webhook/poll interleaving.

## 27. Smallest MVP slice

The smallest useful MVP MUST include:

- A fake-Fizzy and fake-runner vertical slice proving config, routing, claims, workspaces, completion,
  cleanup preservation, and status snapshots before real Fizzy or real Codex are enabled.
- CLI daemon in the selected runtime recorded in `docs/runtime-decision.md`.
- Setup that validates Fizzy identity and writes annotated config.
- Existing-board validation for one watched board.
- Column-scoped native golden tickets only.
- API-filtered, ETag-aware polling for watched boards and golden tickets.
- Required explicit completion policy.
- Polling ingestion.
- Webhook endpoint may be stubbed behind a feature flag, but route semantics and managed-webhook
  setup validation MUST be tested.
- One workspace registry entry using deterministic git worktrees.
- Local instance registry and board-native claim comments.
- Optional assignment/watch visibility when a bot user is configured.
- One persistent agent workpad comment per card.
- One Codex runner implementation through the SDK-shaped interface, using CLI app-server as the MVP
  runner.
- One active run per card and bounded global concurrency.
- Startup recovery for interrupted runs and expired local claims.
- `move_to_column`, `close`, and `comment_once` completion policies.
- No-repeat marker for `comment_once`.
- Non-looping completion-failure marker.
- `/health`, `/ready`, and `/status`.
- Safe cleanup that preserves dirty or unproven worktrees.
- Fake Fizzy and fake Codex runner test suites for routing, claiming, recovery, completion,
  cleanup, runner health, and status snapshots.

MVP MUST NOT include:

- Shared working-directory execution.
- Implicit comment-only completion.
- Silent duplicate golden-ticket resolution.
- Destructive cleanup of dirty worktrees.
- Board-level transition syntax.
- `codex exec` or generic command backend as the normal Codex runner.

## 28. Required test matrix

The implementation MUST include automated tests for the MVP safety surface before it is considered
ready to run against real boards.

Required test groups:

- Config generation: full annotated template, environment indirection, relative path resolution,
  server/status fields, webhook management fields, ETag polling fields, workpad fields, safety
  fields, runner fields, and board route defaults.
- Startup validation: missing secrets, invalid Fizzy access, invalid bot user, duplicate golden
  tickets, tag-only instruction cards, missing completion policy, board-level tickets, managed
  webhook misconfiguration, entropy warning surfacing, missing `WORKFLOW.md`, unsafe cleanup policy,
  invalid runner, invalid server port, invalid claim mode.
- Golden-ticket parsing: native `golden: true` requirement, normalized tags with and without `#`,
  aliases, unknown managed tags, duplicate/conflicting backend/model/workspace/persona/priority/
  completion tags, route ID and route fingerprint stability, duplicate normalized completion
  columns, and completion graph same-column/cycle rejection.
- Unsafe completion policy rejection: missing completion, conflicting completion tags, missing move
  target, disappearing move target, malformed marker parsing, and completion-failure marker creation.
- Card routing precedence: allowed/disallowed card overrides, unknown workspace, unknown model,
  rerun tag, no-repeat marker, completion-failure marker, postponed/closed cards, golden-ticket
  cards ignored.
- Fizzy API usage: API-filtered golden/candidate discovery, ETag `304 Not Modified` handling,
  webhook create/update/reactivate, user/tag listing, assignment/watch visibility, workpad comment
  update failure replacement, and daemon-managed step updates.
- Workspace isolation: deterministic key, named workspace identity, metadata mismatch preservation,
  source repo dirty policy, symlink/path escape rejection, retry reuse, branch naming, guard file.
- Port allocation: fixed-port collision, auto bind-and-hold, next-available allocation, random port,
  registry write after listen, default bind host.
- Multi-instance claim behavior: simultaneous race, loser skip, non-expired claim skip, expired claim
  steal after grace, released claim no longer blocks, multiple renewal comments, renewal failure,
  release failure, stale instance registry.
- Safe cleanup: dirty worktree preservation, untracked file preservation, unpushed commit
  preservation, missing proof preservation, missing result comment preservation, clean-only removal,
  force removal forbidden, release failure before cleanup, durable proof outside cleanup target, and
  crash during cleanup.
- Runner health checks: detect/validate/health success, app-server startup failure, input-required
  failure in unattended mode, timeout, cancellation, metadata extraction, same-thread continuation.
- Status snapshot: health, readiness, runner health, active runs, claims, retry queue, recent
  completions/failures, workspace cleanup state, validation errors, instance registry discovery.
- Event ingestion: webhook dedupe, self-authored event ignore, webhook enqueue path, polling
  correctness after missed webhook, card moved while running to another route, and preempted runs not
  applying old completion policy.

## 29. Deferred decisions

This implementation spec MUST NOT contain open questions that block the MVP. Unresolved product and
runtime topics live in `docs/deferred-scope.md` and `docs/runtime-decision.md`.

MVP decisions:

- The runtime is not selected in this SPEC; it MUST be selected in `docs/runtime-decision.md` before
  implementation starts.
- `comment_once` rerun-on-content-change is route opt-in only.
- Daemon-authored comments are identified by structured marker/workpad content and local status,
  not by an assumed Fizzy authoring primitive.
- Setup MAY offer to create a starter `WORKFLOW.md` only after explicit operator confirmation.
- Board-level golden tickets are deferred.
- Intentional multi-daemon partitioning of the same board is deferred. MVP only requires passive
  coexistence through board-native claims.
