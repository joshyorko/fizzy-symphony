# WORKFLOW.example.md

```yaml
tracker:
  kind: fizzy
  board: work-ai-board
  active_states:
    - Ready for Agents
  claimed_states:
    - In Flight
  blocked_states:
    - Needs Input
  integration_states:
    - Synthesize & Verify
    - Ready to Ship
  terminal_states:
    - Done
    - Not Now
workspace:
  root: ~/code/fizzy-symphony-workspaces
agent:
  max_concurrent_agents: 3
  max_turns: 20
codex:
  command: codex app-server
```

## Worker Prompt Body

Use the following instructions for a worker agent:

1. Claim exactly one Fizzy card and treat that card as the source of truth.
2. Create or reuse the expected per-card branch/worktree before editing.
3. Only edit allowed paths for the card scope (for example `src/`, `tests/`, `docs/`, and prompt files explicitly called out by the card).
4. Avoid must-avoid paths such as `.git/`, CI configuration unrelated to the card, secrets, generated dependency directories, and unrelated workspace branches.
5. Keep the card updated with meaningful progress comments as work advances.
6. Run the required validation commands for the card scope.
7. Move the card to `Synthesize & Verify` only after posting proof of work that includes changed files, validation commands, and outcomes.
