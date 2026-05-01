# Fizzy SDK adapter boundary

`fizzy-symphony` now keeps its daemon-facing Fizzy contract in `src/fizzy-client.js` while routing the default live implementation through `src/fizzy-sdk-adapter.js` and the official published Fizzy TypeScript SDK package, `@37signals/fizzy@0.2.1`.

The older handwritten HTTP client remains in `src/fizzy-http-client.js` as a compatibility layer for:

- explicit test/live overrides that inject `fetch` or a custom transport
- read-style response envelopes that expose `{ status, ok, not_modified, data, metadata }`
- disk-backed ETag persistence used by candidate discovery and other compatibility paths
- orchestration helpers that are above the raw API surface

This keeps the daemon, scheduler, router, validation, setup flow, and tests isolated from SDK-specific internals while letting the Basecamp SDK be the source of truth for normal API operations.

## Migration matrix

| Current adapter method(s) | Status | SDK mapping / rationale |
| --- | --- | --- |
| `getIdentity` | SDK-backed | `client.identity.me()` |
| `listBoards` | SDK-backed | `accountClient.boards.list()` |
| `getBoard` | SDK-backed wrapper | `boards.get()` plus `columns.list()` / `cards.list()` hydration to preserve current return shape |
| `listColumns` | SDK-backed | `columns.list(boardId)` |
| `listCards` | SDK-backed | `cards.list()` with query translation from Symphony snake_case filters to SDK camelCase options |
| `listGoldenCards` | SDK-backed wrapper | `listCards()` with `indexed_by: "golden"` compatibility |
| `getCard`, `refreshCard`, `refreshActiveCards` | SDK-backed | `cards.get()` with existing card-number semantics preserved |
| `listComments`, `getComment`, `createComment`, `updateComment`, `deleteComment` | SDK-backed | `comments.list/get/create/update/delete()` |
| `getStep`, `listSteps`, `createStep`, `updateStep`, `deleteStep` | SDK-backed | `steps.get/list/create/update/delete()` |
| `listTags` | SDK-backed | `tags.list()` |
| `getTag` | Custom compatibility | kept on handwritten client because the current SDK release does not expose `tags.get()` |
| `listUsers`, `getUser` | SDK-backed | `users.list/get()` |
| `listWebhooks`, `getWebhook`, `createWebhook`, `updateWebhook`, `reactivateWebhook`, `listWebhookDeliveries` | SDK-backed | `webhooks.list/get/create/update/activate/listWebhookDeliveries()` |
| `ensureWebhook` | SDK-backed wrapper | adapter-level orchestration around SDK webhook list/update/create/activate calls |
| `getAccountSettings` | SDK-backed | `client.miscellaneous.accountSettings()` |
| `getEntropy` | SDK-backed wrapper | preserves existing warning contract while using SDK-backed account/board reads |
| `createBoard`, `createColumn`, `createCard` | SDK-backed | `boards.create()`, `columns.create()`, `cards.create()` |
| `closeCard`, `reopenCard` | SDK-backed | `cards.close()` / `cards.reopen()` |
| `moveCardToColumn`, `moveCard`, `triageCard`, `sendCardToTriage` | SDK-backed | `cards.triage()` / `cards.untriage()` |
| `toggleTag`, `removeTag` | SDK-backed | `cards.tag()` |
| `markCardGolden`, `markGoldenCard`, `markGolden`, `unmarkCardGolden`, `unmarkGoldenCard` | SDK-backed | `cards.gold()` / `cards.ungold()` |
| `assignCard`, `assignToCard`, `addAssignee` | SDK-backed | `cards.assign()` |
| `watchCard`, `addWatcher`, `unwatchCard` | SDK-backed | `cards.watch()` / `cards.unwatch()` |
| `readIdentity`, `readBoards`, `readBoard`, `readColumns`, `readColumn`, `readCards`, `readGoldenCards`, `readCard`, `readComments`, `readTags`, `readUsers`, `readWebhooks` | Custom compatibility | preserved on the handwritten client because callers rely on the legacy response envelope and persisted ETag behavior |
| `discoverCandidates` | Custom compatibility | preserves existing polling/ETag stats contract |
| `postResultComment`, `recordCompletionMarker`, `recordCompletionFailureMarker` | Custom orchestration | Symphony-specific orchestration helpers built on top of comment/tag operations |

## Runtime behavior

- `createCliFizzyClient()` now uses the SDK-backed adapter by default.
- `startDaemon()` default Fizzy creation still goes through `createFizzyClient()`, which now selects the SDK-backed adapter unless diagnostics mode or explicit fetch/transport overrides are used.
- `diagnostics.no_dispatch` still bypasses all live Fizzy construction and uses the existing noop client.
