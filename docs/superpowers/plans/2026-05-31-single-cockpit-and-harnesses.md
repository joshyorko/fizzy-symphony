# Single Cockpit And Harnesses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `fizzy-symphony` launch a mode-aware terminal cockpit by default, keep advanced commands scriptable, and make the product language/route model ready for easy Claude/Codex harness selection.

**Architecture:** Add a v2 cockpit app-state layer that resolves `SETUP`, `OFFLINE`, `LIVE`, and `DEMO` before building the existing pure cockpit model. Extend the cockpit model with app shell sections, palette entries, safe settings, and advanced command guidance, while keeping daemon mutations behind `/v2/commands` and preserving existing v2 ports. Keep Claude/Codex harness work small in this pass: allow known backend tags and surface them in setup/docs/cockpit without rewriting the whole runner lifecycle.

**Tech Stack:** Node ESM with native TypeScript stripping, Terminal Kit for TTY UI, Node test runner, current v2 runtime and daemon ports.

---

### Task 1: Mode-Aware Cockpit Source Resolution

**Files:**
- Create: `src/v2/cockpit/app-state.ts`
- Modify: `src/v2/cli/cockpit.ts`
- Test: `test/v2/cockpit-cli.test.js`

- [ ] Add tests for missing config -> `SETUP`, config without daemon -> `OFFLINE`, explicit fixture -> `DEMO`, explicit endpoint strict failure, and live registry discovery -> `LIVE`.
- [ ] Add `resolveCockpitApp()` that reads `--config`, `--fixture`, `--endpoint`, registry/default endpoint discovery, and returns `{ app, runtime }`.
- [ ] Generate synthetic empty statuses for `SETUP` and `OFFLINE` so render/model code has no fixture lie.
- [ ] Remove silent default fixture fallback from no-source mode; fixture demo must be explicit.
- [ ] Run `node --test test/v2/cockpit-cli.test.js`.

### Task 2: Bare Command Routes To Cockpit

**Files:**
- Modify: `bin/fizzy-symphony.js`
- Test: `test/cli-production-clients.test.js`

- [ ] Update the old bare-dashboard test to expect cockpit `LIVE`.
- [ ] Add a missing-config bare-command test that expects `SETUP` and does not construct Fizzy/runner clients.
- [ ] Route `!command` through `runCockpitCommand()` after existing bare flag validation.
- [ ] Update usage copy so `fizzy-symphony` is the main command and setup/start/dashboard/status/capabilities/worktrees/doctor are advanced/scriptable.
- [ ] Run `node --test test/cli-production-clients.test.js`.

### Task 3: App Shell Model, Renderer, And Palette

**Files:**
- Modify: `src/v2/core/types.ts`
- Modify: `src/v2/cockpit/model.ts`
- Modify: `src/v2/cockpit/renderer.ts`
- Modify: `src/v2/cockpit/interactive.ts`
- Test: `test/v2/cockpit-model.test.js`
- Test: `test/v2/interactive.test.js`

- [ ] Extend model types with mode banner, section ids, palette entries, next actions, safe settings, and advanced commands.
- [ ] Build sections for Factory, Runs, Worktrees, Doctor, Manual, Events, Settings, and Advanced from one pure model function.
- [ ] Build palette rows with enabled/disabled, disabled reason, mutability, and backing command/endpoint.
- [ ] Render mode banner first in every text frame; render `SETUP` and `OFFLINE` next actions above factory data.
- [ ] Add minimal Terminal Kit shell state for section switching and `Ctrl-P` palette.
- [ ] Run `node --test test/v2/cockpit-model.test.js test/v2/interactive.test.js`.

### Task 4: Harness-Aware Product Path

**Files:**
- Modify: `src/validation.js`
- Modify: `config.example.yml`
- Modify: `docs/user-guide.md`
- Modify: `README.md`
- Modify: `docs/v2/cockpit-contract.md`
- Modify: `docs/v2/decision.md`
- Tests: `test/validation.test.js`, docs copy tests if added

- [ ] Allow known backend tags `claude`, `codex`, `opencode`, `anthropic`, `openai`, and `command` in route parsing without treating non-Codex as unknown managed tags.
- [ ] Keep dispatch honest: non-Codex routes can be configured and shown, but must be disabled for live Codex-only execution until a runner harness exists.
- [ ] Update docs around one-command cockpit flow and easy backend tags (`#claude`, `#codex`) like `fizzy-popper`.
- [ ] Move command lists to Advanced CLI Reference.
- [ ] Run targeted validation/docs tests.

### Task 5: Full Verification

**Files:**
- All changed files

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Run `npm pack --dry-run --json` and verify `src/v2/fixtures/ready.json` is included.
- [ ] Run `node bin/fizzy-symphony.js --once`.
- [ ] Run `node bin/fizzy-symphony.js cockpit --fixture src/v2/fixtures/ready.json --once`.
- [ ] Run `node bin/fizzy-symphony.js capabilities --no-default-endpoint`.
- [ ] Audit the goal requirement-by-requirement before marking complete.
