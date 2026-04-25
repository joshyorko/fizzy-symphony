# RCC Workitems Architecture

Fizzy Symphony should not own durable queue mechanics. Robocorp workitems and
Josh's `robocorp_adapters_custom` already provide the right execution substrate:
reserve, release, output chaining, backend switching, and orphan recovery.

This keeps the project aligned with OpenAI Symphony without copying its daemon
implementation directly. Upstream Symphony keeps claimed/running/retry state in
the orchestrator process; this project can persist that same state in Robocorp
workitems so RCC tasks, local workers, and future services can share it safely.

## Target Shape

- Fizzy remains the board and source of truth.
- `robocorp.workitems` becomes the durable queue API.
- `robocorp_adapters_custom` supplies SQLite, Redis, DocumentDB, or Yorko Control
  Room storage.
- Codex runs inside a worker task and reports proof through work item outputs.
- A reporter task consumes worker outputs and updates Fizzy comments/states.
- `fizzy-symphony` owns all Symphony-specific semantics: board columns,
  `WORKFLOW.md`, per-card workspaces, runner policy, and report formatting.

## Pipeline

```text
Fizzy board
  -> FizzyWorkItemProducer
  -> input queue
  -> CodexWorkItemWorker
  -> result queue
  -> FizzyWorkItemReporter
  -> Fizzy comment/state update
```

## Local Dev Backend

Use SQLite first:

```json
{
  "RC_WORKITEM_ADAPTER": "robocorp_adapters_custom._sqlite.SQLiteAdapter",
  "RC_WORKITEM_QUEUE_NAME": "fizzy_codex_input",
  "RC_WORKITEM_OUTPUT_QUEUE_NAME": "fizzy_codex_results",
  "RC_WORKITEM_DB_PATH": "./output/fizzy-symphony-workitems.db",
  "RC_WORKITEM_FILES_DIR": "./output/workitem-files"
}
```

## Current Code

- `fizzy_symphony.workitem_queue.WorkItemQueue` wraps Robocorp-compatible
  adapters without hard-coding a backend.
- `FizzyWorkItemPayload` defines the card/workflow/runner payload contract.
- `FizzyWorkItemProducer` turns tracker candidate cards into queue items.
- `CodexWorkItemWorker` reserves one item and delegates work to an injected
  runner.
- `FizzyWorkItemReporter` consumes one result and calls the tracker comment/state
  contract.

## Adapter Augmentation

Tracked upstream in:

https://github.com/joshyorko/robocorp_adapters_custom/issues/8

Main missing pieces are duplicate prevention/idempotency, queue metrics, and
clean examples for the three-stage Fizzy/Codex flow.

## Boundary Decision

The adapter package may keep Fizzy examples, but the application brain belongs
in this repository:

- Adapter package: backend selection, queue persistence, reserve/release/fail,
  outputs, files, and orphan recovery.
- Fizzy Symphony: Fizzy CLI tracker integration, OpenAI Symphony mapping,
  producer/worker/reporter policy, and CLI user experience.

That split keeps the cool RCC/workitems backend while preserving the simple
upstream mental model: tracker issue/card in, isolated Codex work out, proof
back on the same tracker issue/card.
