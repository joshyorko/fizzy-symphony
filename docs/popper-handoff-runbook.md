# Popper Handoff Runbook

This runbook documents how `fizzy-popper` is currently driving work on `fizzy-symphony` and how to
operate the local scaffold safely while `fizzy-symphony` is still under construction.

## Roles

- `fizzy-popper` is the temporary board/agent driver. It reads `.fizzy-popper/config.yml` from the
  current working directory and dispatches agents from Fizzy cards.
- `fizzy-symphony` is the target daemon being built. Do not edit the sibling `fizzy-popper` checkout
  for normal `fizzy-symphony` work cards.
- `.fizzy-popper/config.yml` is local, credential-bearing operator configuration. Use it for local
  operation, but do not copy token, account, URL, webhook, board, or workspace values into comments
  or docs.

## Current Implementation Status

The current scaffold is a Node.js ESM project with no external runtime dependencies. The local
baseline on 2026-04-29 is 157/157 passing via `npm test`.

Implemented scaffold behavior:

- config generation and parsing for JSON plus the generated YAML shape
- setup validation hooks
- native golden-ticket startup validation
- route decisions and managed tag normalization
- board-native claim marker construction and parsing
- deterministic workspace metadata and identity helpers
- workflow loading and prompt rendering
- status snapshots
- injected fake-Fizzy and fake-runner reconciliation slice
- real Codex CLI app-server runner behind the SDK-shaped runner interface

The live Fizzy client, full supervisor/completion policy application, durable proof writing,
webhook/poll hardening, and real smoke tests are not implemented yet.

## Workspace Boundaries

On Josh's Bluefin/Universal Blue workstation, prefer repo-native tooling and project containers over
host mutation. This scaffold currently needs only the Node.js already available in the project
environment and the built-in Node test runner.

- Bluefin host: run the documented commands from the repository paths below. Do not install host RPMs
  or layer packages for this scaffold.
- Devcontainer or project container: run the same commands inside the container only when that is
  where the checkout and Node runtime are active.
- Popper workspace context: start Popper from the `fizzy-symphony` directory so it loads
  `fizzy-symphony/.fizzy-popper/config.yml`. Starting from `../fizzy-popper` would target Popper's
  own working directory and the wrong config context.
- CI/GitHub Actions: use `npm test` for this scaffold unless a future card adds a separate CI
  command.

## Local Scaffold Commands

Run tests from the `fizzy-symphony` workspace:

```sh
cd /var/home/kdlocpanda/second_brain/Resources/virtualization/docker/37signals/agent_stuff/fizzy-symphony
npm test
```

Useful local CLI checks:

```sh
cd /var/home/kdlocpanda/second_brain/Resources/virtualization/docker/37signals/agent_stuff/fizzy-symphony
node bin/fizzy-symphony.js setup --template-only --config .fizzy-symphony/config.yml
node bin/fizzy-symphony.js validate --parse-only --config config.json
node bin/fizzy-symphony.js daemon
```

## Starting Popper Safely

Popper's config loader resolves `.fizzy-popper/config.yml` from `process.cwd()`. Always make
`fizzy-symphony` the current working directory before starting Popper for this board.

Preferred command when the sibling Popper checkout has been built:

```sh
cd /var/home/kdlocpanda/second_brain/Resources/virtualization/docker/37signals/agent_stuff/fizzy-symphony
node ../fizzy-popper/dist/cli.js start
```

If `../fizzy-popper/dist/cli.js` is missing, build Popper in the sibling checkout first, then return
to the `fizzy-symphony` workspace before starting it:

```sh
cd /var/home/kdlocpanda/second_brain/Resources/virtualization/docker/37signals/agent_stuff/fizzy-popper
npm install
npm run build

cd /var/home/kdlocpanda/second_brain/Resources/virtualization/docker/37signals/agent_stuff/fizzy-symphony
node ../fizzy-popper/dist/cli.js start
```

For a source/dev Popper checkout with dependencies already installed, the equivalent start command is
still launched from `fizzy-symphony`:

```sh
cd /var/home/kdlocpanda/second_brain/Resources/virtualization/docker/37signals/agent_stuff/fizzy-symphony
../fizzy-popper/node_modules/.bin/tsx ../fizzy-popper/src/cli.ts start
```

The current local sibling Popper checkout may not have `dist/` or `node_modules/`; that is an
environment preparation issue, not a reason to edit Popper source for a `fizzy-symphony` card.

## Board Flow For Future Cards

Future implementation cards should graduate deliberately:

1. `Maybe?`: capture raw ideas, suspected gaps, and possible implementation cards.
2. Intake/triage: decide whether the card belongs in `fizzy-symphony`, whether it is MVP scope, and
   whether it needs shaping.
3. Shaping: write the expected output, likely files, acceptance checks, risks, and exact commands.
4. `Ready for Agents`: move only shaped cards with enough context for an agent to implement without
   editing `fizzy-popper`.
5. Agent work: keep changes scoped to the card, add focused tests before behavior changes, run
   relevant checks, commit/push a branch, and hand off with proof.
6. `Done`: use the route completion policy after verification and review. For the current starter
   board this is normally `#move-to-done`.

## Starter Board And Golden Ticket Assumptions

The MVP assumptions come from `SPEC.md` and should not be expanded by ad hoc board convention:

- routing mode is column-scoped
- dispatch-valid golden tickets are native Fizzy cards with `golden: true`
- dispatch-valid golden tickets must carry `#agent-instructions`
- golden tickets are route descriptors, not repository workflow policy
- every effective route must declare an explicit completion policy
- MVP backend routing is Codex-only through the `codex` or `backend-codex` tag family
- board-level golden tickets are deferred and must be rejected for MVP dispatch

Starter board defaults from the spec:

- agent column: `Ready for Agents`
- completion column: `Done`
- golden ticket title: `Repo Agent`
- golden ticket native status: `golden: true`
- golden ticket tags: `#agent-instructions`, `#codex`, `#move-to-done`
- setup-created starter boards default `agent.max_concurrent` to `1` unless the operator explicitly
  chooses a higher value after seeing the isolation policy

## Known Non-MVP Gaps

These items are intentionally deferred or unsafe for the current MVP:

- shared working-directory execution is not the target design
- implicit comment-only completion is unsafe; completion policy must be explicit
- board-level golden tickets are deferred
- generic command backends and non-Codex backends are not MVP
- `codex exec` is not the normal MVP runner contract
- silent duplicate golden-ticket resolution must not be used
- destructive cleanup of dirty or unproven worktrees must not be used
- real Fizzy smoke tests and model-consuming real Codex smoke tests come after the process/protocol
  seams are covered by unit tests

## Suggested Next Card Ordering

Follow the implementation phases in `SPEC.md` unless a newly discovered safety issue changes the
order:

1. Finish config, setup, and startup validation gaps.
2. Extend deterministic workspace and claim foundations.
3. Build polling, routing precedence, and loop-prevention reconciliation.
4. Add the full supervisor around the SDK-shaped Codex app-server runner.
5. Implement completion policies, proof recording, workpad updates, cleanup guards, and status
   endpoints.
6. Add real Fizzy and real Codex smoke tests only after fake integrations cover the MVP safety
   surface.
