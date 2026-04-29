import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runSetup } from "../src/setup.js";

function boardFixture() {
  return {
    id: "board_1",
    name: "Agent Board",
    columns: [
      { id: "col_ready", name: "Ready for Agents" },
      { id: "col_done", name: "Done" }
    ],
    cards: [
      {
        id: "golden_1",
        title: "Repo Agent",
        golden: true,
        column_id: "col_ready",
        tags: ["agent-instructions", "backend-codex", "move-to-done"]
      }
    ],
    entropy: { auto_postpone_enabled: true, auto_postpone_after_ms: 3600000 }
  };
}

function fakeFizzy(overrides = {}) {
  const calls = [];
  const board = overrides.board ?? boardFixture();
  return {
    calls,
    async getIdentity() {
      calls.push(["getIdentity"]);
      if (overrides.identityError) throw new Error("unauthorized");
      return {
        user: { id: "user_current" },
        accounts: [{ id: "acct_1", name: "Team Account" }]
      };
    },
    async listBoards(account) {
      calls.push(["listBoards", account]);
      return [board];
    },
    async listUsers(account) {
      calls.push(["listUsers", account]);
      return [{ id: "bot_1", name: "Bot" }, { id: "user_current", name: "Human" }];
    },
    async listTags(account) {
      calls.push(["listTags", account]);
      return [
        { id: "tag_agent", name: "agent-instructions" },
        { id: "tag_codex", name: "backend-codex" },
        { id: "tag_done", name: "move-to-done" }
      ];
    },
    async getBoard(boardId) {
      calls.push(["getBoard", boardId]);
      return board;
    },
    async getEntropy(account, boardIds) {
      calls.push(["getEntropy", account, boardIds]);
      return {
        warnings: [
          { code: "ENTROPY_AUTO_POSTPONE", message: "Board auto-postpone is enabled", board_id: board.id }
        ]
      };
    },
    async ensureWebhook(request) {
      calls.push(["ensureWebhook", request]);
      return { id: "webhook_1", status: "active" };
    }
  };
}

function fakeRunner(overrides = {}) {
  return {
    async detect() {
      return overrides.detect ?? { kind: "cli_app_server", available: true, command: "codex" };
    },
    async health() {
      return overrides.health ?? { status: "ready", kind: "cli_app_server" };
    }
  };
}

test("runSetup validates Fizzy identity, lists setup inputs, validates board routes, and writes annotated config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-setup-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  const fizzy = fakeFizzy();

  const result = await runSetup({
    configPath,
    fizzy,
    runner: fakeRunner(),
    account: "acct_1",
    selectedBoardIds: ["board_1"],
    workspaceRepo: dir,
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.account, "acct_1");
  assert.equal(result.boards[0].id, "board_1");
  assert.equal(result.runner.kind, "cli_app_server");
  assert.deepEqual(result.routes.map((route) => route.id), ["board:board_1:column:col_ready:golden:golden_1"]);
  assert.equal(result.warnings[0].code, "ENTROPY_AUTO_POSTPONE");
  assert.deepEqual(
    fizzy.calls.map((call) => call[0]),
    ["getIdentity", "listBoards", "listUsers", "listTags", "getEntropy", "getBoard"]
  );

  const written = await readFile(configPath, "utf8");
  assert.match(written, /# fizzy-symphony config/);
  assert.match(written, /account: acct_1/);
  assert.match(written, /id: board_1/);
  assert.match(written, /preferred: cli_app_server/);
});

test("runSetup resolves managed webhook setup through the injected Fizzy client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-webhook-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const fizzy = fakeFizzy();

  const result = await runSetup({
    configPath: join(dir, "config.yml"),
    fizzy,
    runner: fakeRunner(),
    account: "acct_1",
    selectedBoardIds: ["board_1"],
    workspaceRepo: dir,
    webhook: {
      manage: true,
      callback_url: "https://example.test/fizzy",
      secret: "secret"
    },
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.managedWebhooks.board_1.id, "webhook_1");
  assert.equal(fizzy.calls.at(-1)[0], "ensureWebhook");
  assert.equal(fizzy.calls.at(-1)[1].callback_url, "https://example.test/fizzy");
});

test("runSetup fails before writing config when Fizzy identity is invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-invalid-"));
  const configPath = join(dir, "config.yml");

  await assert.rejects(
    () => runSetup({
      configPath,
      fizzy: fakeFizzy({ identityError: true }),
      runner: fakeRunner(),
      env: { FIZZY_API_TOKEN: "token" }
    }),
    (error) => error.code === "FIZZY_IDENTITY_INVALID"
  );

  await assert.rejects(() => readFile(configPath, "utf8"));
});
