# Prior Art: fizzy-popper

## Summary

Basecamp's `fizzy-popper` is the clearest Fizzy-native implementation of the
OpenAI Symphony idea: a Fizzy board becomes an agent dispatch surface. A card
tagged `#agent-instructions` sits in a column as a golden ticket, work cards
enter that column, a long-running Node/TypeScript service launches an agent,
posts a result, and optionally moves or closes the card.

As of April 26, 2026, `fizzy-popper` is small and intentionally direct:

- Node/TypeScript daemon.
- Polling plus optional webhook ingestion.
- In-memory active-agent supervisor.
- Board-native golden-ticket configuration.
- Multiple backend tags, including Claude, Codex, OpenCode, Anthropic, OpenAI,
  and a command backend.
- No persistent execution database.

That is a strong simple-mode design. It should shape this repository.

## What It Does Better Today

`fizzy-popper` has a better immediate product loop:

1. Configure a board with golden tickets.
2. Start one watcher.
3. Move cards into agent-enabled columns.
4. Watch comments and card movement happen.

It also has a mature-feeling service shape for local/personal use: setup
wizard, status endpoint, webhook receiver, polling reconciler, backend
detection, prompt assembly, and supervisor lifecycle are all in one repo.

If `fizzy-symphony` cannot preserve a clean simple mode, operators should use
or fork `fizzy-popper` instead.

## Where fizzy-symphony Differs

`fizzy-symphony` should not try to be a worse TypeScript daemon. Its useful
lane is Python/RCC durable execution:

```text
Fizzy card -> producer -> workitem lease -> RCC/Codex worker -> result item -> reporter -> Fizzy card
```

Fizzy remains the source of truth for the work:

- card title and description
- comments and proof
- tags and golden-ticket routing
- visible board position
- `Maybe?`, `Not Now`, and `Done` system lanes

Robocorp workitems should only store execution custody:

- which worker leased this run
- when the lease started
- retry attempt count
- input/output payload snapshots
- result waiting for report-back
- local artifact/file handles
- failure state when a worker crashes before posting proof

That distinction matters. It keeps Fizzy human-readable while letting execution
scale beyond one local daemon process.

## Why Durable Mode Can Be Stickier

For one person or a small board, `fizzy-popper` is likely enough.

For a large board with many agents, multiple Codex accounts, RCC containers, or
several worker machines, `fizzy-symphony` can provide a stronger operating
model:

- Multiple producers/workers/reporters can run independently.
- Workers can crash without losing custody state.
- A queue backend can enforce one lease per card.
- Different queues can represent different capacity pools or Codex accounts.
- Reporter failures can be retried without rerunning the worker.
- Artifacts can live with the execution envelope instead of being stuffed into
  Fizzy comments.
- Backpressure and metrics can come from the queue instead of the board alone.

This is the real value proposition. Without that distributed-execution story,
the project should collapse back toward `fizzy-popper`.

## Concepts To Borrow

- Golden tickets: `#agent-instructions` cards configure the column they occupy.
- Backend tags: start with `#codex`; leave room for `#claude`, `#opencode`,
  `#anthropic`, and `#openai`.
- Completion tags: default comment-only, `#close-on-complete`, and
  `#move-to-<column-name>`.
- Prompt assembly: service instructions, golden-ticket prompt, golden-ticket
  steps, card content, card steps, and discussion thread.
- Polling as the baseline reconciler, webhooks as a later accelerator.
- One active execution per card.

## Concepts Not To Copy Yet

- Full daemon/webhook server.
- All backends.
- Direct TypeScript SDK dependence.
- In-memory-only supervisor as the only execution state.
- Making the board mutate directly from every worker process.

## Codex Runner Implication

`fizzy-popper` shells out to supported agent backends. `fizzy-symphony` should
not assume raw CLI subprocesses are the final Codex story. The official Codex
SDK/app-server is a better long-term fit for durable mode because the
orchestrator can keep structured run/thread identity while workitems keep the
lease and retry envelope.

This repo should not build a custom coding-agent harness. Codex is the harness;
`fizzy-symphony` supplies board routing, durable execution custody, and
report-back.

## Stop Conditions

Stop investing in `fizzy-symphony` and prefer `fizzy-popper` if:

- simple mode becomes harder to explain than `fizzy-popper`;
- Robocorp/RCC cannot stay optional;
- durable mode does not demonstrate crash recovery, retry, or multi-worker
  coordination;
- the repo starts storing human workflow truth outside Fizzy.

Continue investing if:

- simple mode remains Popper-like;
- durable mode proves useful for many workers or many Codex accounts;
- Fizzy remains the visible source of truth;
- workitems remain boring execution plumbing.
