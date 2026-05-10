import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { stripAnsi } from "../src/cli-opener.js";
import {
  createHumanDaemonLogger,
  formatDaemonStartSummary,
  formatSetupMutationReview,
  formatSetupSuccess,
  supportsColor
} from "../src/terminal-ui.js";

test("setup success renders the board-native golden route and protected-work hint", () => {
  const rendered = formatSetupSuccess(setupResultFixture(), { color: false });

  assert.match(rendered, /fizzy-symphony is ready/u);
  assert.match(rendered, /Fizzy Symphony Setup/u);
  assert.match(rendered, /\[READY\]/u);
  assert.match(rendered, /Overview/u);
  assert.match(rendered, /Next steps/u);
  assert.match(rendered, /Setup wrote the route into Fizzy/u);
  assert.match(rendered, /Board\s+Agent Playground: repo \(board_1\)/u);
  assert.match(rendered, /Route\s+Ready for Agents -> Done/u);
  assert.match(rendered, /Live board/u);
  assert.match(rendered, /Ready for Agents\s+2 cards/u);
  assert.match(rendered, /#101 Install Rancher/u);
  assert.match(rendered, /#agent-instructions #codex #move-to-done/u);
  assert.match(rendered, /Max agents\s+2/u);
  assert.match(rendered, /Create a normal Fizzy card in Ready for Agents/u);
  assert.match(rendered, /Dirty repos are protected and reported before dispatch/u);
  assert.doesNotMatch(rendered, /\x1b\[/u);
});

test("mutation review is readable as plain text and does not expose token-shaped details", () => {
  const rendered = formatSetupMutationReview({
    setup_mode: "create_starter",
    starter_board_name: "Agent Playground: repo",
    config_path: ".fizzy-symphony/config.yml",
    workflow: { action: "create", path: "/work/repo/WORKFLOW.md" },
    webhook: { manage: false },
    board_ids: []
  }, { icons: false });

  assert.match(rendered, /Review setup changes/u);
  assert.match(rendered, /Create WORKFLOW\.md/u);
  assert.match(rendered, /Create starter board/u);
  assert.match(rendered, /Apply these changes/u);
  assert.doesNotMatch(rendered, /token/u);
});

test("daemon start summary explains routes and dirty-repo protection up front", () => {
  const rendered = formatDaemonStartSummary(daemonFixture(), {
    color: false,
    configPath: ".fizzy-symphony/config.yml",
    boardSnapshots: [boardSnapshotFixture()]
  });

  assert.match(rendered, /fizzy-symphony watching boards/u);
  assert.match(rendered, /Fizzy Symphony Daemon/u);
  assert.match(rendered, /\[RUNNING\]/u);
  assert.match(rendered, /Watched boards/u);
  assert.match(rendered, /Endpoint\s+http:\/\/127\.0\.0\.1:4567/u);
  assert.match(rendered, /Config\s+\.fizzy-symphony\/config\.yml/u);
  assert.match(rendered, /Source repo\s+\/work\/repo/u);
  assert.match(rendered, /Worktrees\s+\/work\/repo\/\.fizzy-symphony\/worktrees/u);
  assert.match(rendered, /Safety\s+protecting your work/u);
  assert.match(rendered, /Inspect\s+fizzy-symphony dashboard --endpoint http:\/\/127\.0\.0\.1:4567/u);
  assert.match(rendered, /Agents/u);
  assert.match(rendered, /Ready -> Done \(codex\)/u);
  assert.match(rendered, /Live board/u);
  assert.match(rendered, /#42 Fix terminal output/u);
  assert.doesNotMatch(rendered, /\x1b\[/u);
});

test("human daemon logger renders dirty-source protection without JSON", () => {
  let stderr = "";
  const logger = createHumanDaemonLogger({
    env: { TERM: "dumb" },
    stderr: {
      isTTY: true,
      write(chunk) {
        stderr += chunk;
      }
    }
  });

  logger.warn("workspace.source_dirty_protected", {
    source_repository_path: "/work/repo",
    dirty_paths: ["README.md"],
    remediation: "Commit or stash the repo changes, then rerun this card."
  });

  assert.doesNotMatch(stderr, /^\{/u);
  assert.match(stripAnsi(stderr), /protecting your work/u);
  assert.match(stripAnsi(stderr), /source repo has local changes/u);
  assert.match(stripAnsi(stderr), /README\.md/u);
  assert.match(stripAnsi(stderr), /Commit or stash/u);
});

test("setup prompt implementation is Terminal Kit-only", async () => {
  const terminalUi = await readFile(new URL("../src/terminal-ui.js", import.meta.url), "utf8");
  const cli = await readFile(new URL("../bin/fizzy-symphony.js", import.meta.url), "utf8");
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");

  assert.match(packageJson, /"terminal-kit"/u);
  assert.doesNotMatch(packageJson, /"@clack\/prompts"/u);
  assert.doesNotMatch(terminalUi, /@clack\/prompts|createClackPromptProvider|shouldUseClackPrompts/u);
  assert.doesNotMatch(cli, /node:readline\/promises|createInterface|terminalPrompts/u);
  assert.equal(supportsColor({ TERM: "xterm-256color" }, { isTTY: true }), true);
  assert.equal(supportsColor({ TERM: "dumb" }, { isTTY: true }), false);
  assert.equal(supportsColor({ TERM: "xterm-256color", CI: "true" }, { isTTY: true }), false);
});

function setupResultFixture() {
  return {
    path: ".fizzy-symphony/config.yml",
    boards: [{
      id: "board_1",
      name: "Agent Playground: repo",
      columns: [
        { id: "col_ready", name: "Ready for Agents" },
        { id: "col_done", name: "Done" }
      ],
      cards: [{
        id: "golden_1",
        number: 100,
        title: "Repo Agent",
        golden: true,
        column_id: "col_ready",
        tags: ["agent-instructions", "codex", "move-to-done"]
      }, {
        id: "card_101",
        number: 101,
        title: "Install Rancher",
        column_id: "col_ready",
        tags: ["codex"]
      }]
    }],
    routes: [{
      board_id: "board_1",
      source_column_name: "Ready for Agents",
      golden_card_id: "golden_1",
      backend: "codex",
      completion: { policy: "move_to_column", target_column_name: "Done" }
    }],
    max_agents: 2,
    runner: { kind: "cli_app_server" }
  };
}

function boardSnapshotFixture() {
  return {
    id: "board_1",
    name: "Agents",
    columns: [
      { id: "col_ready", name: "Ready" },
      { id: "col_done", name: "Done" }
    ],
    cards: [
      {
        id: "golden_1",
        number: 100,
        title: "Repo Agent",
        golden: true,
        column_id: "col_ready",
        tags: ["agent-instructions", "codex", "move-to-done"]
      },
      {
        id: "card_42",
        number: 42,
        title: "Fix terminal output",
        column_id: "col_ready",
        tags: ["codex"]
      }
    ]
  };
}

function daemonFixture() {
  return {
    endpoint: { base_url: "http://127.0.0.1:4567" },
    config: {
      polling: { interval_ms: 30000 },
      workspaces: {
        default: "app",
        default_repo: "/work/repo",
        registry: {
          app: {
            repo: "/work/repo",
            worktree_root: "/work/repo/.fizzy-symphony/worktrees"
          }
        }
      }
    },
    status: {
      status() {
        return {
          instance: { id: "instance-a" },
          watched_boards: [{ id: "board_1", label: "Agents" }],
          routes: [{
            board_id: "board_1",
            source_column_name: "Ready",
            backend: "codex",
            completion: { policy: "move_to_column", target_column_name: "Done" }
          }]
        };
      }
    }
  };
}
