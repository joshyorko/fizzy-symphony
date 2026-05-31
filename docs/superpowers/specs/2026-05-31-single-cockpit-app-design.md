# Single Cockpit App Design

## Status

Draft for Josh review. This design turns the current v2 plumbing into the primary product path without deleting the existing scriptable commands.

## Baseline

The repo currently has useful runtime plumbing:

- `FizzyPort` and `CodexRunnerPort` adapters.
- `/v2/status`, `/v2/capabilities`, `/v2/worktrees`, `/v2/events`, and `/v2/commands`.
- A packaged `src/v2/fixtures/ready.json` demo fixture.
- A v2 `cockpit` command with static text and a thin Terminal Kit wrapper.
- Separate CLI commands for `setup`, `start`, `dashboard`, `status`, `capabilities`, `worktrees`, and `doctor`.

The product problem is that the normal operator path is still fragmented. A user has to know the internal lifecycle and command list before the app helps them.

## Desired Product

The primary operator path is:

```sh
fizzy-symphony
```

or explicitly:

```sh
fizzy-symphony cockpit
```

The cockpit is the app. It detects the current state, shows the right mode, and guides the next action. The older commands remain available for scripting, CI, debugging, and operator escape hatches.

## Modes

The cockpit always shows exactly one mode banner.

| Mode | Condition | User-facing meaning |
| --- | --- | --- |
| `SETUP` | No config exists at the selected config path. | First run. Guide setup instead of dumping commands. |
| `OFFLINE` | Config exists but no daemon is reachable. | Project is configured; daemon is stopped or unreachable. |
| `LIVE` | A local or explicit daemon endpoint answers `/v2/status`. | Real factory status and actions are shown. |
| `DEMO` | No live daemon is reachable and a packaged fixture is used. | Demo data only; never imply live state. |

Explicit `--fixture` always means `DEMO`. Explicit `--endpoint` is strict: if it cannot be reached, show an error instead of silently falling back to demo.

## Entry Points

Bare `fizzy-symphony` should route to the cockpit path, not the old setup/dashboard branch.

The command should preserve the current bare flag discipline:

- Valid bare flags continue to include `--config`, `--endpoint`, `--registry-dir`, `--instance`, `--refresh-ms`, `--once`, and `--no-default-endpoint`.
- Unknown leading flags still show usage and must not construct external clients.

Advanced commands remain:

```sh
fizzy-symphony setup
fizzy-symphony start
fizzy-symphony status
fizzy-symphony dashboard
fizzy-symphony capabilities
fizzy-symphony worktrees
fizzy-symphony doctor --goal
```

Docs should present these as advanced escape hatches, not the quickstart.

## App Shell

The interactive Terminal Kit cockpit should become a real app shell. The first build should keep the implementation compact and rely on existing pure model/runtime boundaries.

Shell regions:

- Header: product name, mode banner, endpoint/config path, readiness, runner state.
- Left nav or section tabs: Factory, Runs, Worktrees, Doctor, Manual, Events, Settings, Advanced.
- Main panel: selected section content.
- Right detail panel: selected card/run/worktree/action details.
- Bottom command bar: keys, current action hint, last result.
- Modal overlay: command palette, help/manual, confirmation text where needed.
- Toast/status area: short success, disabled, unavailable, or error messages.

The non-TTY and `--once` fallback remains plain text, but it should still show the mode banner and next actions.

## Sections

### Factory

Shows board lanes, routes, golden cards, active cards, and current run state. This is the default section in `LIVE` and `DEMO`.

### Runs

Shows queued, running, failed, cancelled, completed, and preempted runs. Failed/stalled runs should surface the error and recommended action.

### Worktrees

Shows dirty/preserved worktrees, branch, path, card, run, dirty paths, and recommended cleanup/triage command.

### Doctor

Shows goal closability, blockers, and exact recommended next action. This replaces making `doctor --goal` part of the normal command list.

### Manual

Shows capabilities, keybindings, and feature map from the same capability registry used by `fizzy-symphony capabilities`.

### Events

Shows recent runtime events and warnings. Live mode reads the daemon event stream; demo mode reads fixture events.

### Settings

Shows config summary that is safe to print: config path, model, reasoning effort, max agents, sandbox/access posture, workspace mode, watched boards, and daemon endpoint. Do not print secrets.

### Advanced

Shows exact CLI commands for scripting/debugging:

- Setup command.
- Start daemon command.
- Status endpoint command.
- Dashboard command.
- Capabilities command.
- Worktree and doctor commands.

This section keeps the scriptable surface discoverable without making it the primary mental model.

## Command Palette

`Ctrl-P` opens a context-aware command palette.

Each command row shows:

- Label.
- Enabled or disabled.
- Disabled reason when unavailable.
- Whether it mutates state.
- Backing command or endpoint.

Initial palette actions:

- Start setup.
- Start daemon.
- Open demo factory.
- Connect to running daemon.
- Open Factory.
- Open Runs.
- Open Worktrees.
- Open Doctor.
- Open Manual.
- Open Events.
- Open Settings.
- Open Advanced.
- Refresh.
- Cancel selected run.
- Stop selected session.
- Move selected card.
- Request rerun.
- Quit.

For this pass, setup and daemon start may be guidance-only if safe in-process launch is not ready. In that case the action must be disabled with a clear reason and exact command, for example:

```text
Start daemon unavailable in this build.
Run: fizzy-symphony start --config .fizzy-symphony/config.yml
```

## First-Run Flow

When config is missing, the cockpit shows a polished setup screen:

```text
Fizzy Symphony
Wonka Factory for Codex agents on Fizzy boards

Mode: SETUP

[Start setup]
[Open demo factory]
[Connect to running daemon]
[Read manual]
[Quit]
```

It should explain what will be created before invoking setup or pointing to the setup command.

## Offline Flow

When config exists and no daemon is reachable, the cockpit shows:

- Mode: `OFFLINE`.
- Config path.
- Project readiness summary from config when cheap to derive.
- Start daemon action or exact fallback command.
- Open demo factory action.
- Advanced commands.

It must not fall straight into demo mode without making the offline state visible.

## Live Flow

When a daemon is reachable, the cockpit shows:

- Mode: `LIVE`.
- Endpoint.
- Factory section by default.
- Live capabilities derived from status.
- Actions that dispatch through `/v2/commands` only when enabled.

## Demo Flow

Demo mode uses the packaged fixture and always shows:

- Mode: `DEMO`.
- No live daemon connected.
- Actions are dry-run/model-only unless explicitly wired otherwise.
- A clear path to setup or daemon start.

Demo mode must never look like live mode.

## Architecture

Keep the current v2 separation:

- CLI entrypoint decides whether bare command or `cockpit` should run the app.
- A new cockpit app-state layer detects mode and source.
- Pure model code derives view models from status, events, capabilities, mode, section, selection, and palette state.
- Renderer draws the model.
- Interactive Terminal Kit code owns input/focus/selection/palette state.
- Runtime remains the only path that mutates state or submits commands.
- Adapters remain behind `FizzyPort` and `CodexRunnerPort`.

Recommended files:

- `src/v2/cockpit/app-state.ts` for mode/source detection and app view input.
- `src/v2/cockpit/model.ts` extension for sections, mode banner, settings, advanced commands, and palette entries.
- `src/v2/cockpit/renderer.ts` for plain text mode-aware output.
- `src/v2/cockpit/interactive.ts` for Terminal Kit shell navigation and palette.
- `src/v2/cli/cockpit.ts` for no-source/fixture/endpoint behavior and setup/offline/demo handling.
- `bin/fizzy-symphony.js` for bare entry routing.

## Error Handling

- Missing config is not an error in the app path; it is `SETUP`.
- Explicit endpoint failure is an error.
- Auto-discovery failure with config present is `OFFLINE`.
- Auto-discovery failure without config is `SETUP`; user can still open demo.
- Fixture load failure is an error only when fixture mode was explicit or the packaged fixture is missing.
- Non-TTY mode prints useful text and exits successfully for `SETUP`, `OFFLINE`, `LIVE`, and `DEMO`.

## Testing

Add acceptance tests for:

- Bare `fizzy-symphony` routes to cockpit/app entry.
- No config shows `SETUP` welcome/setup screen.
- Config but no daemon shows `OFFLINE` / start-daemon guidance.
- Live daemon shows `LIVE` factory mode.
- Fixture fallback shows `DEMO` clearly.
- Explicit `--fixture` is demo-only.
- Explicit unreachable `--endpoint` fails instead of falling back.
- Manual/capabilities are available inside cockpit model.
- Doctor/worktree data are available inside cockpit model.
- Command palette lists actions with enabled/disabled reasons.
- Non-TTY fallback prints useful mode-aware text.
- Advanced CLI commands still work.
- Existing v2 adapter/API/fixture behavior remains green.

Verification gates:

```sh
npm test
npm run build
git diff --check
npm pack --dry-run --json
node bin/fizzy-symphony.js --once
node bin/fizzy-symphony.js cockpit --once
node bin/fizzy-symphony.js capabilities --no-default-endpoint
```

## Non-Goals For This Pass

- Do not delete advanced CLI commands.
- Do not duplicate the setup wizard internals.
- Do not add new adapter features unless needed to keep cockpit actions honest.
- Do not print secrets in Settings or Advanced.
- Do not make demo mode appear live.
- Do not replace Fizzy as the board workflow; the cockpit is the operator shell around it.

## Success Criteria

A new user can run:

```sh
fizzy-symphony
```

and understand what to do next without reading a command list. The app clearly says whether it is in setup, offline, live, or demo mode. The old CLI remains available, but the cockpit feels like the product.
