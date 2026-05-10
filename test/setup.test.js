import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig } from "../src/config.js";
import { runSetup } from "../src/setup.js";
import { validateStartup } from "../src/validation.js";

function boardFixture(overrides = {}) {
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
    entropy: { auto_postpone_enabled: true, auto_postpone_after_ms: 3600000 },
    ...overrides
  };
}

function secondBoardFixture(overrides = {}) {
  return {
    id: "board_2",
    name: "Docs Board",
    columns: [
      { id: "col_docs_ready", name: "Ready for Agents" },
      { id: "col_docs_done", name: "Done" }
    ],
    cards: [
      {
        id: "golden_docs",
        title: "Docs Agent",
        golden: true,
        column_id: "col_docs_ready",
        tags: ["agent-instructions", "codex", "move-to-done"]
      }
    ],
    ...overrides
  };
}

function fakeFizzy(overrides = {}) {
  const calls = [];
  const boards = overrides.boards ?? [overrides.board ?? boardFixture()];
  return {
    calls,
    async getIdentity() {
      calls.push(["getIdentity"]);
      if (overrides.identityError) throw new Error("unauthorized");
      return overrides.identity ?? {
        user: { id: "user_current" },
        accounts: [{ id: "acct_1", name: "Team Account" }]
      };
    },
    async listBoards(account) {
      calls.push(["listBoards", account]);
      return boards;
    },
    async listUsers(account) {
      calls.push(["listUsers", account]);
      return [{ id: "bot_1", name: "Bot" }, { id: "user_current", name: "Human" }];
    },
    async listTags(account) {
      calls.push(["listTags", account]);
      return overrides.tags ?? [
        { id: "tag_agent", name: "agent-instructions" },
        { id: "tag_codex_alias", name: "codex" },
        { id: "tag_codex", name: "backend-codex" },
        { id: "tag_done", name: "move-to-done" }
      ];
    },
    async getBoard(boardId, options = {}) {
      calls.push(["getBoard", boardId, options.account]);
      const board = boards.find((candidate) => candidate.id === boardId);
      if (!board) throw new Error(`missing board ${boardId}`);
      return board;
    },
    async getEntropy(account, boardIds) {
      calls.push(["getEntropy", account, boardIds]);
      return {
        warnings: [
          { code: "ENTROPY_AUTO_POSTPONE", message: "Board auto-postpone is enabled", board_id: boards[0]?.id }
        ]
      };
    },
    async ensureWebhook(request) {
      calls.push(["ensureWebhook", request]);
      return { id: "webhook_1", status: "active" };
    }
  };
}

function fakeStarterFizzy() {
  const calls = [];
  let accountTags = [];
  const board = {
    id: "starter_board",
    name: "Agent Playground: repo",
    columns: [
      { id: "not_now", name: "Not Now" },
      { id: "maybe", name: "Maybe?" },
      { id: "starter_done", name: "Done" }
    ],
    cards: []
  };
  let nextCardNumber = 100;

  return {
    calls,
    async getIdentity() {
      calls.push(["getIdentity"]);
      return {
        user: { id: "user_current" },
        accounts: [{ id: "acct_1", name: "Team Account" }]
      };
    },
    async listBoards(account) {
      calls.push(["listBoards", account]);
      return [];
    },
    async listUsers(account) {
      calls.push(["listUsers", account]);
      return [{ id: "bot_1", name: "Bot" }, { id: "user_current", name: "Human" }];
    },
    async listTags(account) {
      calls.push(["listTags", account]);
      return accountTags;
    },
    async createBoard(request) {
      calls.push(["createBoard", request]);
      board.name = request.name;
      return {
        id: board.id,
        name: request.name,
        columns: [{ id: "partial_ready", name: "Ready for Agents" }]
      };
    },
    async createColumn(request) {
      calls.push(["createColumn", request]);
      const id = request.name === "Ready for Agents" ? "starter_ready" : "starter_ship";
      const column = { id, name: request.name };
      board.columns.push(column);
      return column;
    },
    async createCard(request) {
      calls.push(["createCard", request]);
      const number = nextCardNumber++;
      const card = {
        id: number === 100 ? "starter_golden" : `starter_card_${number}`,
        number,
        title: request.title,
        golden: false,
        column_id: "maybe",
        tags: []
      };
      board.cards.push(card);
      return card;
    },
    async toggleTag(request) {
      calls.push(["toggleTag", request]);
      const card = board.cards.find((candidate) => candidate.id === request.card_id || candidate.number === request.card_number);
      const tag = request.tag_title ?? request.tagTitle ?? request.tag;
      if (card && tag && !card.tags.includes(tag)) card.tags.push(tag);
      if (tag && !accountTags.some((candidate) => candidate.name === tag)) {
        accountTags.push({ id: `tag_${tag}`, name: tag });
      }
      return { ok: true };
    },
    async moveCardToColumn(request) {
      calls.push(["moveCardToColumn", request]);
      const card = board.cards.find((candidate) => candidate.id === request.card_id || candidate.number === request.card_number);
      if (card) card.column_id = request.column_id;
      return { ok: true };
    },
    async markGolden(request) {
      calls.push(["markGolden", request]);
      assert.equal(request.card_number, 100);
      const card = board.cards.find((candidate) => candidate.id === request.card_id || candidate.number === request.card_number);
      if (card) card.golden = true;
      return { ok: true };
    },
    async getBoard(boardId, options = {}) {
      calls.push(["getBoard", boardId, options.account]);
      return board;
    },
    async getEntropy(account, boardIds) {
      calls.push(["getEntropy", account, boardIds]);
      return { warnings: [] };
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

test("runSetup validates Fizzy identity, lists setup inputs, validates board routes, and writes compact config", async () => {
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
  assert.deepEqual(result.resolvedTags["agent-instructions"], { id: "tag_agent", name: "agent-instructions" });
  assert.deepEqual(result.resolvedTags["move-to-done"], { id: "tag_done", name: "move-to-done" });
  assert.deepEqual(result.routes.map((route) => route.id), ["board:board_1:column:col_ready:golden:golden_1"]);
  assert.equal(result.warnings[0].code, "ENTROPY_AUTO_POSTPONE");
  assert.deepEqual(
    fizzy.calls.map((call) => call[0]),
    ["getIdentity", "listBoards", "listUsers", "listTags", "getBoard", "getEntropy"]
  );
  assert.deepEqual(fizzy.calls.find((call) => call[0] === "getBoard"), ["getBoard", "board_1", "acct_1"]);

  const written = await readFile(configPath, "utf8");
  assert.match(written, /# fizzy-symphony/);
  assert.match(written, /account: acct_1/);
  assert.match(written, /id: board_1/);
  assert.match(written, /preferred: cli_app_server/);
  assert.doesNotMatch(written, /terminate_timeout_ms/);
});

test("runSetup prefers live Fizzy account slugs for generated API config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-setup-account-slug-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  const fizzy = fakeFizzy({
    identity: {
      user: { id: "user_current" },
      accounts: [{ id: "acct_uuid", name: "Team Account", slug: "/1" }]
    }
  });

  const result = await runSetup({
    configPath,
    fizzy,
    runner: fakeRunner(),
    selectedBoardIds: ["board_1"],
    workspaceRepo: dir,
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.account, "1");
  assert.deepEqual(
    fizzy.calls.filter((call) => ["listBoards", "listUsers", "listTags", "getEntropy"].includes(call[0])),
    [
      ["listBoards", "1"],
      ["listUsers", "1"],
      ["listTags", "1"],
      ["getEntropy", "1", ["board_1"]]
    ]
  );

  const loaded = await loadConfig(configPath, { env: { FIZZY_API_TOKEN: "token" } });
  assert.equal(String(loaded.fizzy.account), "1");
});

test("runSetup creates a starter board with native golden route defaults and writes max concurrency one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-starter-create-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  const fizzy = fakeStarterFizzy();

  const result = await runSetup({
    configPath,
    fizzy,
    runner: fakeRunner(),
    account: "acct_1",
    setupMode: "create_starter",
    starterBoardName: "Agent Playground: repo",
    workspaceRepo: dir,
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.starter.created, true);
  assert.equal(result.boards[0].id, "starter_board");
  assert.deepEqual(result.boards[0].columns.map((column) => column.name), ["Not Now", "Maybe?", "Done", "Ready for Agents", "Ready To Ship"]);
  assert.deepEqual(
    fizzy.calls.filter((call) => call[0] === "createBoard").map((call) => call[1]),
    [{ account: "acct_1", name: "Agent Playground: repo", all_access: false }]
  );
  assert.deepEqual(
    fizzy.calls.filter((call) => call[0] === "createColumn").map((call) => call[1].name),
    ["Ready for Agents", "Ready To Ship"]
  );
  assert.deepEqual(result.boards[0].cards[0], {
    id: "starter_golden",
    number: 100,
    title: "Repo Agent",
    golden: true,
    column_id: "starter_ready",
    tags: ["agent-instructions", "codex", "move-to-ready-to-ship"]
  });
  assert.deepEqual(
    fizzy.calls.filter((call) => ["listTags", "createBoard", "createColumn", "createCard", "toggleTag", "moveCardToColumn", "markGolden"].includes(call[0])).map((call) => call[0]),
    [
      "listTags",
      "createBoard",
      "createColumn",
      "createColumn",
      "createCard",
      "toggleTag",
      "toggleTag",
      "toggleTag",
      "moveCardToColumn",
      "markGolden",
      "listTags"
    ]
  );
  assert.deepEqual(
    fizzy.calls.filter((call) => call[0] === "createColumn").map((call) => call[1].name),
    ["Ready for Agents", "Ready To Ship"]
  );

  const written = await readFile(configPath, "utf8");
  assert.match(written, /id: starter_board/);
  assert.match(written, /max_concurrent: 1/);
});

test("runSetup lets setup choose the Codex model and maximum active agents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-starter-model-agents-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  const fizzy = fakeStarterFizzy();

  const result = await runSetup({
    configPath,
    fizzy,
    runner: fakeRunner(),
    account: "acct_1",
    setupMode: "create_starter",
    starterBoardName: "Agent Playground: repo",
    workspaceRepo: dir,
    defaultModel: "gpt-5.4",
    maxAgents: 3,
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.default_model, "gpt-5.4");
  assert.equal(result.max_agents, 3);
  const written = await readFile(configPath, "utf8");
  assert.match(written, /default_model: gpt-5\.4/u);
  assert.match(written, /model: gpt-5\.4/u);
  assert.match(written, /max_concurrent: 3/u);
});

test("runSetup rejects invalid max agents before creating remote starter resources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-invalid-max-agents-"));
  const fizzy = fakeStarterFizzy();

  await assert.rejects(
    () => runSetup({
      configPath: join(dir, ".fizzy-symphony", "config.yml"),
      fizzy,
      runner: fakeRunner(),
      account: "acct_1",
      setupMode: "create_starter",
      workspaceRepo: dir,
      maxAgents: 0,
      env: { FIZZY_API_TOKEN: "token" }
    }),
    (error) => error.code === "INVALID_MAX_AGENTS"
  );

  assert.equal(fizzy.calls.some((call) => call[0] === "createBoard"), false);
});

test("runSetup cancels create-starter setup before workflow, board, or config mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-starter-cancel-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  const fizzy = fakeStarterFizzy();
  const plans = [];

  await assert.rejects(
    () => runSetup({
      configPath,
      fizzy,
      runner: fakeRunner(),
      account: "acct_1",
      setupMode: "create_starter",
      starterBoardName: "Agent Playground: repo",
      workspaceRepo: dir,
      workflowPolicy: { action: "create" },
      prompts: {
        async confirmSetupMutations(plan) {
          plans.push(plan);
          return false;
        }
      },
      env: { FIZZY_API_TOKEN: "token" }
    }),
    (error) => error.code === "SETUP_MUTATION_CANCELLED"
  );

  assert.deepEqual(plans.map((plan) => plan.mutations), [["create_workflow", "create_starter_board", "write_config"]]);
  assert.equal(fizzy.calls.some((call) => call[0] === "createBoard"), false);
  await assert.rejects(() => readFile(join(dir, "WORKFLOW.md"), "utf8"));
  await assert.rejects(() => readFile(configPath, "utf8"));
});

test("runSetup creates starter WORKFLOW.md only when workflow policy says create", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-workflow-create-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");

  const result = await runSetup({
    configPath,
    fizzy: fakeStarterFizzy(),
    runner: fakeRunner(),
    account: "acct_1",
    setupMode: "create_starter",
    starterBoardName: "Agent Playground: repo",
    workspaceRepo: dir,
    workflowPolicy: { action: "create" },
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.workflow.action, "created");
  const workflow = await readFile(join(dir, "WORKFLOW.md"), "utf8");
  assert.match(workflow, /Repository workflow/u);
  assert.match(workflow, /Fizzy card and golden-ticket instructions/u);
  assert.doesNotMatch(workflow, /npm test/u);
});

test("runSetup skips missing WORKFLOW.md and still writes config when workflow policy says skip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-workflow-skip-"));
  const fizzy = fakeStarterFizzy();
  const configPath = join(dir, ".fizzy-symphony", "config.yml");

  const result = await runSetup({
    configPath,
    fizzy,
    runner: fakeRunner(),
    account: "acct_1",
    setupMode: "create_starter",
    workspaceRepo: dir,
    workflowPolicy: { action: "skip" },
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.workflow.action, "missing_skipped");
  assert.equal(result.starter.created, true);
  assert.equal(fizzy.calls.some((call) => call[0] === "createBoard"), true);
  await assert.rejects(() => readFile(join(dir, "WORKFLOW.md"), "utf8"));
  assert.match(await readFile(configPath, "utf8"), /fallback_enabled: true/u);
});

test("runSetup can add an optional normal smoke-test card to a starter board", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-smoke-card-"));
  const fizzy = fakeStarterFizzy();

  const result = await runSetup({
    configPath: join(dir, ".fizzy-symphony", "config.yml"),
    fizzy,
    runner: fakeRunner(),
    account: "acct_1",
    setupMode: "create_starter",
    workspaceRepo: dir,
    createSmokeTestCard: true,
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.boards[0].cards.length, 2);
  assert.deepEqual(result.boards[0].cards.map((card) => [card.title, card.golden, card.column_id]), [
    ["Repo Agent", true, "starter_ready"],
    ["Smoke test fizzy-symphony", false, "starter_ready"]
  ]);
});

test("runSetup appends a fizzy-symphony section to existing WORKFLOW.md only when requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-workflow-append-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n\nKeep existing rules.\n", "utf8");

  const result = await runSetup({
    configPath: join(dir, ".fizzy-symphony", "config.yml"),
    fizzy: fakeFizzy(),
    runner: fakeRunner(),
    account: "acct_1",
    selectedBoardIds: ["board_1"],
    workspaceRepo: dir,
    workflowPolicy: { action: "append" },
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.workflow.action, "appended");
  const workflow = await readFile(join(dir, "WORKFLOW.md"), "utf8");
  assert.match(workflow, /Keep existing rules/u);
  assert.match(workflow, /## fizzy-symphony/u);
  assert.match(workflow, /Fizzy card/u);
});

test("runSetup adopts an existing starter board and keeps starter concurrency defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-starter-adopt-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const configPath = join(dir, "config.yml");

  const result = await runSetup({
    configPath,
    fizzy: fakeFizzy(),
    runner: fakeRunner(),
    account: "acct_1",
    setupMode: "adopt_starter",
    selectedBoardIds: ["board_1"],
    workspaceRepo: dir,
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.starter.created, false);
  assert.equal(result.routes[0].completion.policy, "move_to_column");
  assert.match(await readFile(configPath, "utf8"), /max_concurrent: 1/);
});

test("runSetup writes every selected board to the generated config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-multiboard-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const configPath = join(dir, ".fizzy-symphony", "config.yml");

  await runSetup({
    configPath,
    fizzy: fakeFizzy({ boards: [boardFixture(), secondBoardFixture()] }),
    runner: fakeRunner(),
    account: "acct_1",
    selectedBoardIds: ["board_1", "board_2"],
    workspaceRepo: dir,
    env: { FIZZY_API_TOKEN: "token" }
  });

  const written = await readFile(configPath, "utf8");
  assert.match(written, /id: board_1/);
  assert.match(written, /label: Agent Board/);
  assert.match(written, /id: board_2/);
  assert.match(written, /label: Docs Board/);
});

test("runSetup passes live boards into the setup-mode prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-mode-board-context-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const seen = [];

  await runSetup({
    configPath: join(dir, ".fizzy-symphony", "config.yml"),
    fizzy: fakeFizzy({ boards: [boardFixture(), secondBoardFixture()] }),
    runner: fakeRunner(),
    account: "acct_1",
    workspaceRepo: dir,
    workflowPolicy: { action: "skip" },
    prompts: {
      async selectSetupMode(modes, context) {
        seen.push({
          modes,
          boards: context.boards.map((board) => [board.id, board.name])
        });
        return "existing";
      },
      async selectBoards(boards) {
        return [boards[1]];
      }
    },
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.deepEqual(seen, [{
    modes: ["existing", "create_starter", "adopt_starter"],
    boards: [["board_1", "Agent Board"], ["board_2", "Docs Board"]]
  }]);
});

test("runSetup refuses to guess among multiple existing boards without a prompt or board flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-missing-board-selection-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");

  await assert.rejects(
    () => runSetup({
      configPath: join(dir, ".fizzy-symphony", "config.yml"),
      fizzy: fakeFizzy({ boards: [boardFixture(), secondBoardFixture()] }),
      runner: fakeRunner(),
      account: "acct_1",
      setupMode: "existing",
      workspaceRepo: dir,
      workflowPolicy: { action: "skip" },
      env: { FIZZY_API_TOKEN: "token" }
    }),
    (error) => {
      assert.equal(error.code, "SETUP_BOARD_SELECTION_REQUIRED");
      assert.match(error.details.remediation, /--board/u);
      return true;
    }
  );
});

test("runSetup writes default config paths that resolve to the selected workspace repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-default-config-paths-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const configPath = join(dir, ".fizzy-symphony", "config.yml");

  await runSetup({
    configPath,
    fizzy: fakeFizzy(),
    runner: fakeRunner(),
    account: "acct_1",
    selectedBoardIds: ["board_1"],
    workspaceRepo: dir,
    env: { FIZZY_API_TOKEN: "token" }
  });

  const config = await loadConfig(configPath, { env: { FIZZY_API_TOKEN: "token" } });
  assert.equal(config.workspaces.default_repo, dir);
  assert.equal(config.workspaces.registry.app.repo, dir);
  assert.ok(config.safety.allowed_roots.includes(dir));

  const startup = await validateStartup({
    config,
    fizzy: fakeFizzy(),
    runner: fakeRunner()
  });
  assert.equal(startup.ok, true, JSON.stringify(startup.errors));
});

test("runSetup writes managed remote source config when workspaceRepo is a Git URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-remote-setup-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");

  await runSetup({
    configPath,
    fizzy: fakeFizzy(),
    runner: fakeRunner(),
    account: "acct_1",
    selectedBoardIds: ["board_1"],
    workspaceRepo: "https://example.test/owner/repo.git",
    workspaceRepoRef: "main",
    sourceCacheRoot: join(dir, ".cache", "sources"),
    env: { FIZZY_API_TOKEN: "token" }
  });

  const config = await loadConfig(configPath, { env: { FIZZY_API_TOKEN: "token" } });
  assert.equal(config.workspaces.registry.app.source, "app");
  assert.equal(config.workspaces.registry.app.repo, undefined);
  assert.equal(config.workspaces.sources.app.type, "git_remote");
  assert.equal(config.workspaces.sources.app.remote_url, "https://example.test/owner/repo.git");
  assert.equal(config.workspaces.sources.app.base_ref, "main");
  assert.equal(config.workspaces.source_cache_root, join(dir, ".cache", "sources"));
  assert.equal(config.safety.allowed_roots.includes(join(dir, ".cache", "sources")), true);

  const startup = await validateStartup({
    config,
    fizzy: fakeFizzy(),
    runner: fakeRunner()
  });
  assert.equal(startup.ok, true, JSON.stringify(startup.errors));
});

test("runSetup preserves non-credentialed SSH and SCP remote Git URLs", async () => {
  const remotes = [
    "ssh://git@example.test/owner/repo.git",
    "git@example.test:owner/repo.git"
  ];

  for (const [index, remote] of remotes.entries()) {
    const dir = await mkdtemp(join(tmpdir(), `fizzy-symphony-remote-ssh-${index}-`));
    const configPath = join(dir, ".fizzy-symphony", "config.yml");

    await runSetup({
      configPath,
      fizzy: fakeFizzy(),
      runner: fakeRunner(),
      account: "acct_1",
      selectedBoardIds: ["board_1"],
      workspaceRepo: remote,
      workspaceRepoRef: "main",
      sourceCacheRoot: join(dir, ".cache", "sources"),
      env: { FIZZY_API_TOKEN: "token" }
    });

    const config = await loadConfig(configPath, { env: { FIZZY_API_TOKEN: "token" } });
    assert.equal(config.workspaces.sources.app.remote_url, remote);
  }
});

test("runSetup rejects credentialed remote Git URLs before writing config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-remote-creds-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");

  await assert.rejects(
    () => runSetup({
      configPath,
      fizzy: fakeFizzy(),
      runner: fakeRunner(),
      account: "acct_1",
      selectedBoardIds: ["board_1"],
      workspaceRepo: "https://user:secret@example.test/owner/repo.git",
      env: { FIZZY_API_TOKEN: "token" }
    }),
    (error) => {
      assert.equal(error.code, "CONFIG_INVALID_WORKSPACE_SOURCE");
      assert.equal(error.details.value, "https://example.test/owner/repo.git");
      assert.equal(JSON.stringify(error).includes("secret"), false);
      return true;
    }
  );

  await assert.rejects(() => readFile(configPath, "utf8"));
});

test("loadConfig rejects credentialed remote Git URLs with redacted details", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-config-remote-creds-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  await mkdir(join(dir, ".fizzy-symphony"));
  await writeFile(configPath, [
    "fizzy:",
    "  token: $FIZZY_API_TOKEN",
    "  account: acct_1",
    "boards:",
    "  entries:",
    "    - id: board_1",
    "workspaces:",
    "  source_cache_root: .cache/sources",
    "  sources:",
    "    app:",
    "      type: git_remote",
    "      remote_url: https://user:secret@example.test/owner/repo.git",
    "      base_ref: main",
    "      fetch_depth: 0",
    "      auth: auto",
    "  registry:",
    "    app:",
    "      source: app",
    "safety:",
    "  allowed_roots:",
    "    - .cache/sources",
    ""
  ].join("\n"), "utf8");

  await assert.rejects(
    () => loadConfig(configPath, { env: { FIZZY_API_TOKEN: "token" } }),
    (error) => {
      assert.equal(error.code, "CONFIG_INVALID_WORKSPACE_SOURCE");
      assert.equal(error.details.value, "https://example.test/owner/repo.git");
      assert.equal(JSON.stringify(error).includes("secret"), false);
      return true;
    }
  );
});

test("runSetup manages webhooks by listing, creating, updating, and reactivating without requiring an optional secret", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-managed-webhooks-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const boards = [
    boardFixture(),
    secondBoardFixture(),
    secondBoardFixture({ id: "board_3", name: "Third Board", cards: [
      {
        id: "golden_3",
        title: "Third Agent",
        golden: true,
        column_id: "col_docs_ready",
        tags: ["agent-instructions", "codex", "move-to-done"]
      }
    ] })
  ];
  const fizzy = fakeFizzy({ boards });
  fizzy.ensureWebhook = undefined;
  fizzy.listWebhooks = async (request) => {
    fizzy.calls.push(["listWebhooks", request]);
    if (request.board_id === "board_1") return [];
    if (request.board_id === "board_2") {
      return [{ id: "webhook_inactive", callback_url: "https://example.test/fizzy", active: false, subscribed_actions: ["comment_created"] }];
    }
    return [{ id: "webhook_stale", callback_url: "https://example.test/fizzy", active: true, subscribed_actions: ["card_closed"] }];
  };
  fizzy.createWebhook = async (request) => {
    fizzy.calls.push(["createWebhook", request]);
    return { id: `created_${request.board_id}`, active: true };
  };
  fizzy.updateWebhook = async (request) => {
    fizzy.calls.push(["updateWebhook", request]);
    return { id: request.webhook_id, active: true };
  };
  fizzy.reactivateWebhook = async (request) => {
    fizzy.calls.push(["reactivateWebhook", request]);
    return { id: request.webhook_id, active: true };
  };

  const result = await runSetup({
    configPath: join(dir, "config.yml"),
    fizzy,
    runner: fakeRunner(),
    account: "acct_1",
    selectedBoardIds: ["board_1", "board_2", "board_3"],
    workspaceRepo: dir,
    webhook: {
      manage: true,
      callback_url: "https://example.test/fizzy",
      subscribed_actions: ["comment_created"]
    },
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.managedWebhooks), ["board_1", "board_2", "board_3"]);
  assert.ok(result.warnings.some((warning) => warning.code === "WEBHOOK_SECRET_NOT_CONFIGURED"));
  assert.deepEqual(
    fizzy.calls.filter((call) => ["listWebhooks", "createWebhook", "updateWebhook", "reactivateWebhook"].includes(call[0])).map((call) => call[0]),
    ["listWebhooks", "createWebhook", "listWebhooks", "reactivateWebhook", "listWebhooks", "updateWebhook"]
  );
});

test("runSetup requires interactive mutation review before managed webhooks and config writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-mutation-review-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const configPath = join(dir, "config.yml");
  const fizzy = fakeFizzy();
  const prompts = [];

  await assert.rejects(
    () => runSetup({
      configPath,
      fizzy,
      runner: fakeRunner(),
      account: "acct_1",
      selectedBoardIds: ["board_1"],
      workspaceRepo: dir,
      webhook: {
        manage: true,
        callback_url: "https://example.test/fizzy",
        secret: "super-secret-token"
      },
      prompts: {
        async input(prompt) {
          prompts.push(prompt);
          return "no";
        }
      },
      env: { FIZZY_API_TOKEN: "token" }
    }),
    (error) => error.code === "SETUP_MUTATION_CANCELLED"
  );

  assert.deepEqual(prompts.map((prompt) => prompt.name), ["setup_mutation_review"]);
  assert.doesNotMatch(JSON.stringify(prompts), /super-secret-token/u);
  assert.equal(fizzy.calls.some((call) => call[0] === "ensureWebhook"), false);
  await assert.rejects(() => readFile(configPath, "utf8"));
});

test("runSetup rejects unsafe existing golden-ticket structure before writing config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-unsafe-golden-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const configPath = join(dir, "config.yml");

  await assert.rejects(
    () => runSetup({
      configPath,
      fizzy: fakeFizzy({
        board: boardFixture({
          cards: [{ id: "tag_only", golden: false, column_id: "col_ready", tags: ["agent-instructions", "move-to-done"] }]
        })
      }),
      runner: fakeRunner(),
      account: "acct_1",
      selectedBoardIds: ["board_1"],
      workspaceRepo: dir,
      env: { FIZZY_API_TOKEN: "token" }
    }),
    (error) => error.code === "TAG_ONLY_INSTRUCTION_CARD"
  );

  await assert.rejects(() => readFile(configPath, "utf8"));
});

test("runSetup falls back to cli_app_server when SDK detection lacks an exact package and contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-sdk-fallback-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");

  const result = await runSetup({
    configPath: join(dir, "config.yml"),
    fizzy: fakeFizzy(),
    runner: fakeRunner({ detect: { kind: "sdk", available: true, package: "@openai/codex" } }),
    account: "acct_1",
    selectedBoardIds: ["board_1"],
    workspaceRepo: dir,
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.runner.kind, "cli_app_server");
  assert.equal(result.runner.reason, "SDK runner requires an exact package and contract.");
  assert.match(await readFile(join(dir, "config.yml"), "utf8"), /preferred: cli_app_server/);
});

test("runSetup falls back from arbitrary SDK package and contract because no SDK is selected for MVP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-sdk-arbitrary-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");

  const result = await runSetup({
    configPath: join(dir, "config.yml"),
    fizzy: fakeFizzy(),
    runner: fakeRunner({
      detect: {
        kind: "sdk",
        available: true,
        package: "@openai/codex-sdk",
        contract: "codex-sdk-js-v1"
      }
    }),
    account: "acct_1",
    selectedBoardIds: ["board_1"],
    workspaceRepo: dir,
    env: { FIZZY_API_TOKEN: "token" }
  });

  assert.equal(result.runner.kind, "cli_app_server");
  assert.equal(result.runner.fallback_from, "sdk");
  const written = await readFile(join(dir, "config.yml"), "utf8");
  assert.match(written, /preferred: cli_app_server/);
  assert.doesNotMatch(written, /package:/);
  assert.doesNotMatch(written, /contract:/);
});

test("runSetup fails existing-board validation when required managed tags cannot be resolved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-tags-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");

  await assert.rejects(
    () => runSetup({
      configPath: join(dir, "config.yml"),
      fizzy: fakeFizzy({ tags: [{ id: "tag_codex", name: "backend-codex" }] }),
      runner: fakeRunner(),
      account: "acct_1",
      selectedBoardIds: ["board_1"],
      workspaceRepo: dir,
      env: { FIZZY_API_TOKEN: "token" }
    }),
    (error) => error.code === "MANAGED_TAG_NOT_FOUND" && error.details.missing.includes("agent-instructions")
  );
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
