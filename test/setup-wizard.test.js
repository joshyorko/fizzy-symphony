import test from "node:test";
import assert from "node:assert/strict";

import { FizzySymphonyError } from "../src/errors.js";
import {
  createSetupWizardPromptProvider,
  shouldUseSetupWizardPromptProvider
} from "../src/setup-wizard.js";

test("setup wizard provider exposes the full runSetup prompt contract", async () => {
  const provider = await createSetupWizardPromptProvider(fakeIo(), {}, {
    adapter: fakeAdapter()
  });

  assert.equal(typeof provider.input, "function");
  assert.equal(typeof provider.selectAccount, "function");
  assert.equal(typeof provider.selectSetupMode, "function");
  assert.equal(typeof provider.selectBoards, "function");
  assert.equal(typeof provider.configureSetupDefaults, "function");
  assert.equal(typeof provider.confirmWorkflowPolicy, "function");
  assert.equal(typeof provider.confirmSetupMutations, "function");
});

test("setup wizard returns create-starter choices without mutating setup state", async () => {
  const adapter = fakeAdapter([
    ["input", "https://fizzy.example.test"],
    ["input", "token-from-terminal"],
    ["menu", accountFixture("acct_2", "Build Team")],
    ["menu", "create_starter"],
    ["input", "gpt-5.5"],
    ["menu", "high"],
    ["input", "1"],
    ["menu", "protected_worktree"],
    ["menu", "create"],
    ["confirm", true]
  ]);
  const provider = await createSetupWizardPromptProvider(fakeIo(), {}, { adapter });

  assert.equal(await provider.input({ name: "fizzy_api_url", message: "Fizzy API URL" }), "https://fizzy.example.test");
  assert.equal(await provider.input({ name: "fizzy_api_token", message: "Fizzy API token", secret: true }), "token-from-terminal");
  assert.deepEqual(await provider.selectAccount([
    accountFixture("acct_1", "Ops"),
    accountFixture("acct_2", "Build Team")
  ]), accountFixture("acct_2", "Build Team"));
  assert.equal(await provider.selectSetupMode(["existing", "create_starter", "adopt_starter"]), "create_starter");
  assert.deepEqual(await provider.configureSetupDefaults({
    defaultModel: "gpt-5",
    reasoningEffort: "medium",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    maxAgents: 1,
    workspaceMode: "protected_worktree",
    workspaceModes: ["protected_worktree", "no_dispatch"]
  }), {
    defaultModel: "gpt-5.5",
    reasoningEffort: "high",
    maxAgents: 1,
    workspaceMode: "protected_worktree"
  });
  assert.deepEqual(await provider.confirmWorkflowPolicy({ exists: false, path: "/repo/WORKFLOW.md" }), { action: "create" });
  assert.equal(await provider.confirmSetupMutations({
    setup_mode: "create_starter",
    starter_board_name: "Agent Playground: repo",
    config_path: ".fizzy-symphony/config.yml",
    workflow: { action: "create", path: "/repo/WORKFLOW.md" },
    webhook: { manage: false },
    board_ids: [],
    mutations: ["create_workflow", "create_starter_board", "write_config"]
  }), true);

  assert.deepEqual(adapter.calls.map((call) => call[0]), [
    "section",
    "input",
    "section",
    "input",
    "section",
    "menu",
    "section",
    "menu",
    "section",
    "input",
    "menu",
    "input",
    "menu",
    "section",
    "menu",
    "section",
    "note",
    "confirm"
  ]);
});

test("setup wizard supports the existing-board lane and adopt-starter selection", async () => {
  const boards = [
    boardFixture("board_1", "Core Board"),
    boardFixture("board_2", "Starter Board")
  ];

  const adoptAdapter = fakeAdapter([
    ["menu", "adopt_starter"],
    ["menu", boards[1]]
  ]);
  const adoptProvider = await createSetupWizardPromptProvider(fakeIo(), {}, { adapter: adoptAdapter });

  assert.equal(await adoptProvider.selectSetupMode(["existing", "create_starter", "adopt_starter"], { boards }), "adopt_starter");
  assert.deepEqual(await adoptProvider.selectBoards(boards), [boards[1]]);

  const existingAdapter = fakeAdapter([
    ["menu", "existing"],
    ["multiselect", [boards[0], boards[1]]]
  ]);
  const existingProvider = await createSetupWizardPromptProvider(fakeIo(), {}, { adapter: existingAdapter });

  assert.equal(await existingProvider.selectSetupMode(["existing", "create_starter", "adopt_starter"], { boards }), "existing");
  assert.deepEqual(await existingProvider.selectBoards(boards), boards);
});

test("setup wizard uses one board-path menu and previews existing boards before selection", async () => {
  const boards = [
    boardFixture("board_1", "Core Board"),
    boardFixture("board_2", "Starter Board")
  ];
  const adapter = fakeAdapter([
    ["menu", "existing"],
    ["multiselect", [boards[0]]]
  ]);
  const provider = await createSetupWizardPromptProvider(fakeIo(), {}, { adapter });

  assert.equal(
    await provider.selectSetupMode(["existing", "create_starter", "adopt_starter"], { boards }),
    "existing"
  );
  assert.deepEqual(await provider.selectBoards(boards), [boards[0]]);

  const modeMenu = adapter.calls.find((call) => call[0] === "menu");
  assert.equal(modeMenu[1].message, "How should setup configure boards?");
  assert.deepEqual(modeMenu[1].choices.map((choice) => choice.label), [
    "Create recommended starter board",
    "Use existing board(s)",
    "Adopt existing starter board"
  ]);
  assert.match(modeMenu[1].choices[1].hint, /2 boards found/u);

  const boardPreview = adapter.calls.find((call) => call[0] === "note" && call[1].title === "Available boards");
  assert.match(boardPreview[1].text, /Core Board/u);
  assert.match(boardPreview[1].text, /Starter Board/u);
});

test("setup wizard cancellation before mutations throws SETUP_CANCELLED", async () => {
  const provider = await createSetupWizardPromptProvider(fakeIo(), {}, {
    adapter: fakeAdapter([
      ["confirm", { canceled: true, key: "q" }]
    ])
  });

  await assert.rejects(
    () => provider.confirmSetupMutations({
      setup_mode: "existing",
      config_path: ".fizzy-symphony/config.yml",
      workflow: { action: "none", path: "/repo/WORKFLOW.md" },
      webhook: { manage: false },
      board_ids: ["board_1"],
      mutations: ["write_config"]
    }),
    (error) => {
      assert.ok(error instanceof FizzySymphonyError);
      assert.equal(error.code, "SETUP_CANCELLED");
      assert.equal(error.details.key, "q");
      assert.equal(error.details.step, "mutation_review");
      return true;
    }
  );
});

test("setup wizard does not treat arbitrary fake TTY streams as the process terminal", () => {
  assert.equal(shouldUseSetupWizardPromptProvider(fakeIo(), { TERM: "xterm-256color" }), false);
  assert.equal(shouldUseSetupWizardPromptProvider(fakeIo(), { TERM: "xterm-256color" }, {
    terminal: fakeTerminal()
  }), true);
});

test("setup wizard grabs and releases an injected terminal explicitly", async () => {
  const terminal = fakeTerminal();
  const provider = await createSetupWizardPromptProvider(fakeIo(), { TERM: "xterm-256color" }, {
    terminal
  });

  assert.deepEqual(terminal.grabs, [{ mouse: "button" }]);
  provider.close();
  assert.deepEqual(terminal.grabs, [{ mouse: "button" }, false]);
});

test("terminal setup wizard frames board selection with details and selected state", async () => {
  const boards = [
    boardFixture("board_1", "Core Board", {
      description: "Production dispatch lane",
      columns: [{}, {}],
      cards: [{ golden: true }]
    }),
    boardFixture("board_2", "Starter Board", {
      description: "Starter route for new agents",
      columns: [{}, {}, {}],
      cards: []
    })
  ];
  const terminal = fakeTerminal([
    ["menu", 1],
    ["menu", 1],
    ["menu", 2]
  ]);
  const provider = await createSetupWizardPromptProvider(fakeIo(), { TERM: "xterm-256color" }, {
    terminal
  });

  assert.equal(
    await provider.selectSetupMode(["existing", "create_starter", "adopt_starter"], { boards }),
    "existing"
  );
  assert.deepEqual(await provider.selectBoards(boards), boards);

  const output = terminal.outputText();
  assert.match(output, /fizzy-symphony setup wizard/u);
  assert.match(output, /Step 1/u);
  assert.match(output, /Board path/u);
  assert.match(output, /Review detected boards before choosing what setup will watch/u);
  assert.match(output, /Core Board/u);
  assert.match(output, /board_1/u);
  assert.match(output, /Production dispatch lane/u);
  assert.match(output, /2 columns/u);
  assert.match(output, /1 golden route/u);

  const boardMenus = terminal.menus.filter((menu) => (
    menu.items.some((item) => item.includes("Use selected boards"))
  ));
  assert.equal(boardMenus.length, 2);
  assert.match(boardMenus[0].items.join("\n"), /\[x\] Core Board.*board_1.*Production dispatch lane/u);
  assert.match(boardMenus[0].items.join("\n"), /\[ \] Starter Board.*board_2.*Starter route for new agents/u);
  assert.match(boardMenus[1].items.join("\n"), /\[x\] Starter Board.*board_2.*Starter route for new agents/u);
});

function fakeIo() {
  return {
    stdin: { isTTY: true },
    stdout: { isTTY: true, write() {} },
    stderr: { isTTY: true, write() {} },
    env: { TERM: "xterm-256color" }
  };
}

function fakeAdapter(script = []) {
  const calls = [];
  const queue = [...script];

  function next(kind) {
    const entry = queue.shift();
    assert.ok(entry, `missing fake adapter response for ${kind}`);
    assert.equal(entry[0], kind);
    return entry[1];
  }

  return {
    calls,
    section(title) {
      calls.push(["section", title]);
    },
    note(text, title) {
      calls.push(["note", { title, text }]);
    },
    async input(prompt) {
      calls.push(["input", prompt]);
      return next("input");
    },
    async menu(prompt) {
      calls.push(["menu", prompt]);
      return next("menu");
    },
    async multiselect(prompt) {
      calls.push(["multiselect", prompt]);
      return next("multiselect");
    },
    async confirm(prompt) {
      calls.push(["confirm", prompt]);
      return next("confirm");
    }
  };
}

function accountFixture(id, name) {
  return { id, name, slug: `/${id}` };
}

function boardFixture(id, name, attrs = {}) {
  return { id, name, columns: [], cards: [], ...attrs };
}

function fakeTerminal(script = []) {
  const queue = [...script];
  const output = [];
  function terminal(text) {
    output.push(String(text));
  }
  terminal.grabs = [];
  terminal.menus = [];
  terminal.grabInput = (value) => {
    terminal.grabs.push(value);
  };
  terminal.singleColumnMenu = (items, options) => {
    terminal.menus.push({ items, options });
    const entry = queue.shift();
    assert.ok(entry, "missing fake terminal menu response");
    assert.equal(entry[0], "menu");
    return { promise: Promise.resolve({ selectedIndex: entry[1] }) };
  };
  terminal.outputText = () => output.join("");
  return terminal;
}
