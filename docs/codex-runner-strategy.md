# Codex Runner Strategy

`fizzy-symphony` should use Codex as the coding-agent harness. It should not
rebuild Codex with the OpenAI Agents SDK.

## Official SDK Shape

OpenAI documents a Codex SDK for programmatic control of local Codex agents:

- TypeScript package: `@openai/codex-sdk`
- Python SDK: experimental, controls the local Codex app-server over JSON-RPC,
  requires Python 3.10+, and currently expects a local checkout of the
  open-source Codex repo
- Non-interactive `codex exec --json` remains a useful fallback because it emits
  structured JSONL events, but the SDK gives a cleaner thread/resume/run API.

That means the cleanest first implementation is not a hard runtime dependency
in this Python package. The cleanest first step is a runner boundary that can
call Codex through the SDK when available.

## Recommended Integration

Add a runner contract before adding a concrete SDK dependency:

```text
CodexRunRequest
  card_number
  workspace
  prompt
  model
  approval_policy
  timeout_seconds
  metadata

CodexRunResult
  final_response
  success
  thread_id
  artifacts
  validation_summary
  raw_metadata
```

Then implement runners in this order:

1. `CodexSdkRunner` spike using the official SDK/app-server.
2. `CodexCliRunner` fallback for non-interactive `codex` CLI execution.
3. Optional TypeScript sidecar if the TypeScript SDK stays more stable than the
   experimental Python SDK.

The workitem worker should depend on the runner contract, not the concrete SDK.
Do not add a default dependency on either SDK until a local spike proves the
auth, app-server, and packaging path works in Josh's Bluefin/devcontainer setup.

## How This Fits Durable Mode

The workitem queue owns execution custody:

- reserve one card payload;
- start or resume a Codex thread for that card;
- write `thread_id` and runtime metadata to the result payload;
- release the item only after the worker has produced a result item.

The reporter owns Fizzy writeback:

- post the final response or proof summary;
- move/close according to the golden-ticket completion policy;
- retry writeback without rerunning Codex.

This lets the system scale to multiple workers while still using Codex's own
agent harness.

## Multiple Codex Accounts

Multiple Codex accounts are an operations problem, not a board-model problem.
Durable mode can support them by assigning workers to capacity pools:

- separate containers or OS users;
- separate `CODEX_HOME` / config homes;
- queue names or worker labels per account;
- per-account concurrency limits.

Do not mix credential state inside one worker process.

## Authentication Notes

Codex supports ChatGPT sign-in for subscription access and API-key sign-in for
usage-based access. Durable mode should treat auth as worker-local runtime
state, not as Fizzy board state. For CI-style or fleet workers, prefer explicit
worker profiles/containers so account limits and credentials are observable.

## Agents SDK Decision

The OpenAI Agents SDK is useful when an application owns tools, handoffs,
approvals, and agent state. That is not the desired shape here. This repo should
own board routing and durable queue custody, then delegate coding execution to
Codex through the Codex SDK/app-server.
