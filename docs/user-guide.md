# fizzy-symphony Quickstart

This should feel like starting an app, not hand-wiring a board.

Run these from the repo root on your Bluefin host or another Linux shell:

```sh
npm install
fizzy-symphony setup
fizzy-symphony start
fizzy-symphony dashboard
```

In the repo checkout, the same commands are:

```sh
node bin/fizzy-symphony.js setup
node bin/fizzy-symphony.js start
node bin/fizzy-symphony.js dashboard
```

That is the normal path.

`setup` is the normal first-run path. `init` still works, but it is only a deprecated compatibility alias for `setup`.

Interactive `setup` launches the opener and then uses the Terminal Kit TUI for the setup wizard. It asks for any missing Fizzy URL/token values, lets you create a starter board or adopt/wire an existing route, checks Fizzy and Codex, then shows the mutating actions before it applies them. Guided setup writes a compact `.fizzy-symphony/config.yml`.

Non-interactive setup must be explicit. In CI, redirected shells, and dumb terminals, pass the scripted setup flags for the lane you want, or run `setup --template-only --config PATH` when you only need the annotated config template.

`WORKFLOW.md` is optional repo policy, not the workflow source of truth. The golden card and each work card are the visible workflow. When `WORKFLOW.md` exists, fizzy-symphony adds it to agent context; when it is absent, the built-in fallback keeps setup usable.

`WORKFLOW.md` file changes are explicit:

- use `--create-starter-workflow` to create a starter file when none exists
- use `--augment-workflow` to append the fizzy-symphony section to an existing file
- use `--no-workflow-change` to leave the file alone

If the repo does not have `WORKFLOW.md`, pressing Enter at the setup prompt is not consent to create one silently. Choose create/append/skip in the prompt, or use the matching flag.

Setup writes a hard-pinned Codex model into the generated config and starter route instead of relying on the Codex CLI default. Use `--model` or `--codex-model` to override that model, and use `--reasoning-effort` or `--reasoning` to choose the Codex reasoning effort. Use `--max-agents` to set the initial active-agent limit:

```sh
fizzy-symphony setup --model <codex-model> --reasoning-effort medium --max-agents 1
```

The generated `.fizzy-symphony/config.yml` keeps these operator choices in one place:

```yaml
agent:
  default_model: gpt-5.5
  reasoning_effort: medium
  max_concurrent: 1
```

Maximum active agents stays on `--max-agents` and `agent.max_concurrent`; starter-board setup defaults it to `1`.

Generated setup state under `.fizzy-symphony/` is ignored by source protection, so config/status/workspace metadata dirt does not block dispatch. Real user edits elsewhere in the repo still block when the clean-source policy is enabled.

`start` runs the local daemon.

`dashboard` reads the daemon's existing `/status` endpoint and renders that status. In a TTY it refreshes by default; use `--once` for a static snapshot. In non-TTY, CI, or dumb terminals it prints the same information as text. It is not a clickable workflow editor and does not keep a separate workflow model.

## What You Do In Fizzy

After `setup`, open the starter board it created or adopted.

You will see:

- Fizzy's system columns, such as `Not Now`, `Maybe?`, and `Done`
- `Ready for Agents`
- `Ready To Ship`
- one golden card named `Repo Agent`

Do not edit the golden card for the first smoke test. It is the route.

Create a normal card in `Ready for Agents`. That card is the task.

The daemon should:

1. claim the card
2. run Codex in a git worktree
3. comment with the result
4. add an `agent-completed-*` tag
5. move the card to `Ready To Ship`

That is the whole workflow.

## Mental Model

The board is the UI.

The golden card says what agents should do for that column. Normal cards are work requests. `WORKFLOW.md` is only optional repo policy that gets added to the agent context.

The dashboard is an observer for daemon status. It helps you see readiness, routes, active runs, claims, failures, webhook errors, and cleanup state, but Fizzy remains the visible workflow layer.

## Useful Commands

```sh
node bin/fizzy-symphony.js status
node bin/fizzy-symphony.js boards
node bin/fizzy-symphony.js dashboard
node bin/fizzy-symphony.js dashboard --once
node bin/fizzy-symphony.js validate
node bin/fizzy-symphony.js start
```

If you want to use a different env file, Codex model, or reasoning effort:

```sh
fizzy-symphony setup --dotenv path/to/.env --api-url https://fizzy.example.com --model <codex-model> --reasoning medium
```

If you already built a Fizzy board route yourself, use the explicit scripted path:

```sh
fizzy-symphony boards
fizzy-symphony setup --mode existing --board BOARD_ID --workspace-repo .
fizzy-symphony start
```

`boards` is read-only. Use it to see the board IDs, columns, and golden cards Fizzy already has
before you wire an existing board.

If you want a non-interactive starter board setup, spell out the lane:

```sh
fizzy-symphony setup --mode create-starter --workspace-repo . --api-url https://fizzy.example.com --token "$FIZZY_API_TOKEN"
```

Starter-board setup creates a limited-access board for the current Fizzy user, not an Everyone board.

If the board already has the starter route and you want setup to use starter defaults:

```sh
fizzy-symphony setup --adopt-starter --board BOARD_ID --workspace-repo .
```

Existing routes still use the same board-native contract: a native golden card tagged `agent-instructions`, `codex`, and one completion tag like `move-to-done`, `close-on-complete`, or `comment-once`.

## Gated Live E2E Smoke

The live smoke is checked in but skipped unless explicitly enabled. It creates a disposable Fizzy starter board and smoke card, starts the real daemon against a temporary git repo, runs one reconciliation tick through Codex/worktree dispatch, and verifies a result comment, completion marker/tag, and final card column.

Run it only from a Linux shell with live Fizzy credentials and Codex available:

```sh
FIZZY_SYMPHONY_LIVE_E2E=1 \
FIZZY_SYMPHONY_LIVE_CONFIRM=real-fizzy-codex-worktree \
FIZZY_API_TOKEN=... \
npm run test:live:e2e
```

Optional env:

- `FIZZY_API_URL` defaults to `https://app.fizzy.do`
- `FIZZY_SYMPHONY_LIVE_ACCOUNT` selects a specific account when the token can see more than one
- `FIZZY_SYMPHONY_LIVE_TIMEOUT_MS` defaults to `600000`

The generated config stores `token: $FIZZY_API_TOKEN`; the test asserts the token value is not written.
