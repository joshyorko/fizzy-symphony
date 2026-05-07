# Deferred Scope

This document captures deferred ideas and non-blocking questions. `SPEC.md` must stay
decision-bearing for the MVP.

## Deferred Fizzy API Capabilities

- Pins as an operator focus surface.
- Reactions/boosts as machine-readable status.
- Board publication/unpublication for public demo boards.
- Direct-upload attachments for screenshots, coverage reports, logs, and other large artifacts.
- Daemon-driven reopen, untriage, and Not Now transitions beyond cancellation/route handling.
- Daemon-driven card title/body rewrites except under a future explicit policy.
- Deleting daemon comments or steps as normal operation.

## Deferred Routing And Board Semantics

- Board-level golden tickets with a structured route schema.
- One golden ticket defining multiple transitions.
- Intentional partitioning where several daemons own different columns on the same board.
- Default rerun-on-card-content-change for `comment_once` routes.

## Deferred Runner Decisions

- Exact Codex SDK package and language binding after the App Server MVP.
- Whether a future implementation should prefer SDK mode over App Server mode for non-TypeScript
  runtimes.
- Whether generated JSON Schema bindings are sufficient for the selected runtime.
- Broader Codex approval/sandbox policy modes beyond the currently honored unattended-safe
  app-server behavior.

## Deferred Workspace Isolation Strategies

- `git_clone` isolation for repositories where worktrees are not suitable.
- `copy` isolation for source trees without usable VCS metadata.

## Deferred Setup Enhancements

- Starter `WORKFLOW.md` templates beyond explicit operator-confirmed creation.
- Public demo-board publishing.
- Rich artifact attachment policy for proof, screenshots, coverage, and logs.

None of these items block the MVP unless they are promoted into `SPEC.md` with explicit normative
requirements.
