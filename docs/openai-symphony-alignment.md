# OpenAI Symphony Alignment

## TL;DR

Fizzy Symphony follows the original OpenAI Symphony product model, not the exact
runtime implementation.

```text
OpenAI Symphony:
Linear issue -> orchestrator state -> Codex workspace/session -> Linear update

Fizzy Symphony:
Fizzy card -> Robocorp workitem state -> Codex workspace/command -> Fizzy update
```

The visible tracker remains the source of truth in both systems. The durable
queue layer is the deliberate divergence.

## Concept Mapping

| OpenAI Symphony | Fizzy Symphony | Why |
| --- | --- | --- |
| Linear project | Existing Fizzy board | Keep work visible to humans in the tracker. |
| Linear issue | Fizzy card | One unit of agent work. |
| Linear status | Fizzy column | Human-readable workflow state. |
| Orchestrator state | Robocorp workitem state | Durable reserve/release/fail/output semantics. |
| Codex app-server session | Codex worker command/session | One isolated worker per card. |
| Issue comment | Fizzy comment | Proof of work goes back to the original card. |
| `WORKFLOW.md` | `WORKFLOW.md` / `WORKFLOW.example.md` | Repo-owned workflow contract. |

## Board Ownership

Fizzy Symphony does not create a hidden board by default. It expects an existing
Fizzy board and can print a bootstrap plan for recommended columns:

```bash
fizzy-symphony init-board --board <board-id>
```

Recommended columns:

- `Shaping`
- `Ready for Agents`
- `In Flight`
- `Needs Input`
- `Synthesize & Verify`
- `Ready to Ship`
- `Done`

## Package Boundary

`robocorp-adapters-custom` should stay boring and durable:

- select backend from environment
- seed input items
- reserve input items
- create output items
- release items as done or failed
- store files/attachments
- recover orphaned reserved items

`fizzy-symphony` should own orchestration:

- Fizzy board/column semantics
- OpenAI Symphony concept mapping
- `WORKFLOW.md` policy
- per-card workspace policy
- Codex runner configuration
- producer/worker/reporter CLI UX
- proof/report formatting

## Local Happy Path

```bash
pip install -e ".[dev,workitems]"
fizzy-symphony doctor --board <board-id>
fizzy-symphony init-board --board <board-id>
fizzy-symphony workitems-env
```

Then use the producer/worker/reporter helpers with a Robocorp-compatible adapter.
The workitem queue is invisible plumbing; the Fizzy card remains where humans
read scope, comments, state, and proof.
