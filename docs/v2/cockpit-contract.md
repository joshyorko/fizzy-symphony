# v2 Cockpit Contract

The cockpit is a thin, deterministic projection of a single source of truth — the
`SymphonyStatus` document — plus a small, validated command vocabulary. This file
is the contract every layer agrees on: daemon, ports, model, renderer, and CLI.

All types referenced here are defined in
[src/v2/core/types.ts](../../src/v2/core/types.ts).

---

## 1. Status document — `SymphonyStatus`

The runtime's entire observable state. Schema-stamped with
`STATUS_SCHEMA_VERSION = "fizzy-symphony-status-v2"`.

| Field | Meaning |
| --- | --- |
| `instance` | Daemon identity, pid, endpoint. |
| `readiness` | `state` ∈ `ready \| blocked \| locked \| unknown`, plus `blockers[]`, `dispatchPaused`. |
| `capabilities` | What the build can do (see §4). |
| `boards` / `routes` / `cards` | Board topology and per-card runtime state. |
| `runs` | Bucketed by state: `queued/running/completed/failed/cancelled/preempted`. |
| `claims` | Claim-marker lifecycle on cards. |
| `worktrees` | Per-workspace dirty/preserved flags, dirty paths, last error. |
| `retryQueue` | Pending retries with attempt/next-retry. |
| `capacityRefusals` | Cards refused due to `--max-agents` capacity. |
| `doctor` | `goalClosable` + blockers (goal-closing doctor). |
| `warnings` / `recentEvents` | Diagnostics surface. |

`normalizeStatus(raw)` ([core/status.ts](../../src/v2/core/status.ts)) is **pure**:
it fills empty collections, stamps the schema, infers `readiness.state`
(`blocked` when blockers exist, `locked` when `dispatchPaused`), and never mutates
its input.

### Derived factory state

`deriveFactoryState(status)` maps readiness + activity to a Wonka-themed
`FactoryState` (`open | running | blocked | locked | unknown`) for the header.

---

## 2. Cockpit model — `CockpitModel`

`createCockpitModel(input: CockpitModelInput)`
([cockpit/model.ts](../../src/v2/cockpit/model.ts)) is **pure**: no IO, no fetch,
no mutation, no clock reads beyond what's in the status. Given a status (+ optional
events, capabilities, selection, filter) it returns a fully resolved view:

- `header` — instance, endpoint, readiness, factory state, counts.
- `lanes[]` — one per route; each lane carries themed cards with a `hazard` flag.
- `selected` — the selected item; `raw` holds the unembellished truth
  (`boardId/cardId/runId/sessionId/workspacePath/error`) used to build commands.
- `panels` — `activeRuns`, `worktrees`, `doctor`, `events`, `capabilities`.
- `actions[]` — operator actions with `key`, `enabled`, and `disabledReason`.
- `help` — keymap + capability list.

**Selection order** (for keyboard navigation) is stable: cards (in lane order),
then running runs, then worktrees.

### Action enable/disable

Actions are never hidden when unavailable — they are shown **disabled with a
reason**, computed via `checkCommandAvailability` + `deriveCapabilities`. Examples:

| Action | Key | Disabled reason example |
| --- | --- | --- |
| Lock factory (pause) | `p` | `Dispatch is already paused.` |
| Unlock factory (resume) | `u` | `Dispatch is not paused.` |
| Cancel selected run | `c` | `No run selected` |
| Stop selected session | `s` | `Selected item has no active session` |
| Request rerun of card | `R` | `No card selected` |

The renderer never decides availability — it only displays what the model resolved.

---

## 3. Command vocabulary — `OperatorCommand`

A closed union (no free-form commands):

```
dispatch.pause   { reason? }
dispatch.resume  { reason? }
run.cancel       { runId, reason }
session.stop     { sessionId, reason }
card.rerun       { cardId, reason }
card.move        { cardId, targetColumnId, reason }
worktree.preserve{ workspaceKey, reason }
worktree.cleanup { workspaceKey, reason }
```

### Command pipeline (single choke point: `runtime.submitCommand`)

1. **`validateCommand(payload)`** — shape/required-field check. Codes:
   `INVALID_COMMAND`, `UNKNOWN_COMMAND`, `MISSING_FIELD`, `MISSING_REASON`.
   Failure → `outcome: "rejected"`.
2. **`checkCommandAvailability(command, status)`** — semantic availability against
   current status. Codes: `NO_ACTIVE_RUN`, `NO_ACTIVE_SESSION`, `ALREADY_PAUSED`,
   `NOT_PAUSED`, `UNKNOWN_CARD`, `CARD_RUNNING`, `UNKNOWN_WORKTREE`.
   Failure → `outcome: "unavailable"`.
3. **Apply.** If `applyCommands` is `false` (spike default), the command is
   recorded as a `command.dry-run.<type>` event and returns `outcome: "dry-run"`.
   If `true`, it emits `command.accepted.<type>` and returns `outcome: "accepted"`.

`CommandResult.outcome` ∈ `accepted | rejected | unavailable | dry-run`.

> No render or model path ever submits a command or mutates state. Commands flow
> only through `submitCommand`.

---

## 4. Capabilities — honest feature advertisement

`core/capabilities.ts` holds a catalogue of 14 capabilities across categories
(`fizzy/codex/board/route/runner/worktree/doctor/control/webhook/diagnostics`).
`deriveCapabilities(status)` disables those that cannot run *right now*, with a
reason:

- `codex.run` → `Runner not ready` when the runner isn't healthy.
- `codex.cancel` / `session.stop` → `No active run` when nothing is running.

`fizzy-symphony capabilities [--json] [--fixture|--endpoint]` prints this list so an
operator can see, before touching anything, exactly what the build can and cannot
do.

---

## 5. Local API — `/v2/...`

`handleApiRequest(runtime, method, pathname, body)`
([daemon/api.ts](../../src/v2/daemon/api.ts)) is a **pure router**; `createApiServer`
wraps it in a real `http` server.

| Method & path | Behavior |
| --- | --- |
| `GET /v2/health` | Liveness. |
| `GET /v2/ready` | `503` when readiness ≠ ready. |
| `GET /v2/status` | Full `SymphonyStatus`. |
| `GET /v2/capabilities` | Derived capabilities. |
| `GET /v2/events` | Recent runtime events. |
| `GET /v2/runs` | Run buckets. |
| `GET /v2/runs/:id` | `404` if unknown. |
| `GET /v2/worktrees` | Worktree summaries. |
| `POST /v2/commands` | `202` dry-run/accepted, `409` unavailable, `400` rejected. |

The cockpit CLI can drive itself from a live endpoint (`--endpoint`) or a fixture
(`--fixture`), proving the same model renders identically from either source.

---

## 6. Ports (translated at the edges)

### `FizzyPort` — independent of `@37signals/fizzy`

Hand-written board/card/comment/webhook interface. Implementations:
- `createFakeFizzyPort(seed)` — deterministic, fixture-backed (`sdk: false`).
- `createFizzyAdapter({ mode: "sdk" | "http" })` — boundary; live ops throw
  `FIZZY_ADAPTER_NOT_WIRED` in the spike. `describe()` advertises the mode.

### `CodexRunnerPort` — SDK-compatible lifecycle

`detect / health / startSession / startTurn / streamTurn / cancelTurn /
stopSession / terminateOwnedProcess`. Implementations:
- `createFakeCodexRunner({ mode })` — deterministic streaming
  (`completed | failed | input_required`), contract `codex-runner-fake-v2`.
- `createCodexAdapter({ mode: "sdk" | "cli-app-server" })` — boundary; contracts
  `codex-runner-sdk-v1` / `codex-runner-cli-app-server-v1`; live ops throw
  `CODEX_ADAPTER_NOT_WIRED`; `health()` reports `ADAPTER_NOT_WIRED`.

---

## 7. Rendering

- `renderCockpitText(model)` ([cockpit/renderer.ts](../../src/v2/cockpit/renderer.ts))
  — pure string frame for non-TTY / `--once`. Sections: header, board/factory
  lanes, selected detail, active runs, worktrees/doctor, activity, actions,
  footer/keys.
- `startInteractiveCockpit({ runtime, terminalFactory? })`
  ([cockpit/interactive.ts](../../src/v2/cockpit/interactive.ts)) — Terminal Kit
  loop (lazily imported). Keys: `q/ESC/Ctrl-C` quit, `r` refresh, `?` help,
  arrows/`j`/`k` navigate, `a` actions, and `p/u/c/s/R` submit the corresponding
  command (always via `runtime.submitCommand`).

Hazards (dirty worktrees, failed runs, blocked doctor) are visually obvious in the
rendered text — verified by `test/v2/fixtures-render.test.js`.
