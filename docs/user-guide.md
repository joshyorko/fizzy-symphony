# fizzy-symphony Quickstart

This should feel like starting an app, not hand-wiring a board.

Run these from the repo root on your Bluefin host or another Linux shell:

```sh
npm install
fizzy-symphony setup
fizzy-symphony start
```

In the repo checkout, the same commands are:

```sh
node bin/fizzy-symphony.js setup
node bin/fizzy-symphony.js start
```

That is the normal path.

Interactive `setup` launches the opener, asks for any missing Fizzy URL/token values, checks Fizzy and Codex, creates the starter board route, writes `.fizzy-symphony/config.yml`, and creates a starter `WORKFLOW.md` if the repo does not have one yet.

`init` remains a compatible alias for the same first-run flow.

`start` runs the local daemon.

## What You Do In Fizzy

After `setup`, open the created board.

You will see:

- `Ready for Agents`
- `Done`
- one golden card named `Repo Agent`

Do not edit the golden card for the first smoke test. It is the route.

Create a normal card in `Ready for Agents`. That card is the task.

The daemon should:

1. claim the card
2. run Codex in a git worktree
3. comment with the result
4. add an `agent-completed-*` tag
5. move the card to `Done`

That is the whole workflow.

## Mental Model

The board is the UI.

The golden card says what agents should do for that column. Normal cards are work requests. `WORKFLOW.md` is only repo policy that gets added to the agent context.

## Useful Commands

```sh
node bin/fizzy-symphony.js status
node bin/fizzy-symphony.js validate
node bin/fizzy-symphony.js start
```

If you want to use a different env file:

```sh
fizzy-symphony setup --dotenv path/to/.env --api-url https://fizzy.example.com
```

If you already built a Fizzy board route yourself:

```sh
fizzy-symphony setup --mode existing --board BOARD_ID --workspace-repo .
fizzy-symphony start
```

Existing routes still use the same board-native contract: a native golden card tagged `agent-instructions`, `codex`, and one completion tag like `move-to-done`, `close-on-complete`, or `comment-once`.
