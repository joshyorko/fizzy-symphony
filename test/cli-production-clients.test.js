import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { main as cliMain } from "../bin/fizzy-symphony.js";
import { writeAnnotatedConfig } from "../src/config.js";

test("public setup constructs production clients when injected clients are absent", async () => {
  const dir = await setupWorkspace("fizzy-symphony-cli-setup-factory-");
  const configPath = join(dir, "config.yml");
  const calls = [];

  const result = await runCli([
    "setup",
    "--config",
    configPath,
    "--account",
    "acct_1",
    "--board",
    "board_1",
    "--workspace-repo",
    dir
  ], {
    env: { FIZZY_API_TOKEN: "token", FIZZY_API_URL: "https://app.fizzy.test" },
    clientFactories: {
      createFizzyClient({ config }) {
        calls.push(["createFizzyClient", config.fizzy.api_url, Boolean(config.fizzy.token)]);
        return fakeSetupFizzy();
      },
      createRunner({ config }) {
        calls.push(["createRunner", config.runner?.preferred ?? "cli_app_server"]);
        return fakeRunner();
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(calls, [
    ["createFizzyClient", "https://app.fizzy.test", true],
    ["createRunner", "cli_app_server"]
  ]);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    path: configPath,
    account: "acct_1",
    boards: ["board_1"],
    runner: "cli_app_server",
    warnings: []
  });
  assert.match(await readFile(configPath, "utf8"), /id: board_1/);
});

test("public validate constructs real Fizzy and runner clients in normal mode", async () => {
  const dir = await setupWorkspace("fizzy-symphony-cli-validate-factory-");
  const configPath = await writeConfig(dir);
  const calls = [];

  const result = await runCli(["validate", "--config", configPath], {
    env: { FIZZY_API_TOKEN: "token" },
    clientFactories: {
      createFizzyClient({ config }) {
        calls.push(["createFizzyClient", config.fizzy.account]);
        return fakeValidationFizzy();
      },
      createRunner({ config }) {
        calls.push(["createRunner", config.runner.preferred]);
        return fakeRunner({ calls });
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(calls, [
    ["createFizzyClient", "acct"],
    ["createRunner", "cli_app_server"],
    ["runner.detect", "cli_app_server"],
    ["runner.validate", "cli_app_server"],
    ["runner.health", "cli_app_server"]
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "startup");
  assert.equal(payload.runnerHealth.status, "ready");
  assert.deepEqual(payload.errors, []);
});

test("public validate parse-only stays config-only and does not construct external clients", async () => {
  const dir = await setupWorkspace("fizzy-symphony-cli-parse-only-");
  const configPath = await writeConfig(dir);

  const result = await runCli(["validate", "--parse-only", "--config", configPath], {
    env: { FIZZY_API_TOKEN: "token" },
    clientFactories: {
      createFizzyClient() {
        throw new Error("parse-only should not construct a Fizzy client");
      },
      createRunner() {
        throw new Error("parse-only should not construct a runner");
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, mode: "parse-only" });
});

test("public validate does not use noop runner defaults when diagnostics.no_dispatch is set", async () => {
  const dir = await setupWorkspace("fizzy-symphony-cli-no-dispatch-");
  const configPath = await writeConfig(dir, { noDispatch: true });
  const calls = [];

  const result = await runCli(["validate", "--config", configPath], {
    env: { FIZZY_API_TOKEN: "token" },
    clientFactories: {
      createFizzyClient() {
        calls.push(["createFizzyClient"]);
        return fakeValidationFizzy();
      },
      createRunner() {
        calls.push(["createRunner"]);
        return fakeRunner({
          calls,
          health: {
            status: "unavailable",
            kind: "cli_app_server",
            remediation: "Install or expose the Codex CLI."
          }
        });
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(calls, [
    ["createFizzyClient"],
    ["createRunner"],
    ["runner.detect", "cli_app_server"],
    ["runner.validate", "cli_app_server"],
    ["runner.health", "cli_app_server"]
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.runnerHealth.status, "unavailable");
});

test("public setup reports missing Fizzy credentials with remediation", async () => {
  const dir = await setupWorkspace("fizzy-symphony-cli-missing-token-");
  const result = await runCli([
    "setup",
    "--config",
    join(dir, "config.yml"),
    "--workspace-repo",
    dir
  ], {
    env: { FIZZY_API_URL: "https://app.fizzy.test" }
  });

  assert.equal(result.exitCode, 2);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.code, "FIZZY_CREDENTIALS_MISSING");
  assert.match(payload.details.remediation, /FIZZY_API_TOKEN/);
});

test("public setup reports unreachable Fizzy API with remediation", async () => {
  const dir = await setupWorkspace("fizzy-symphony-cli-api-down-");
  const result = await runCli([
    "setup",
    "--config",
    join(dir, "config.yml"),
    "--workspace-repo",
    dir
  ], {
    env: { FIZZY_API_TOKEN: "token", FIZZY_API_URL: "https://app.fizzy.test" },
    fetch: async () => {
      throw new TypeError("fetch failed");
    }
  });

  assert.equal(result.exitCode, 2);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.code, "FIZZY_IDENTITY_INVALID");
  assert.match(payload.details.remediation, /FIZZY_API_URL/);
});

test("public setup reports missing Codex runner with remediation", async () => {
  const dir = await setupWorkspace("fizzy-symphony-cli-missing-runner-");
  const result = await runCli([
    "setup",
    "--config",
    join(dir, "config.yml"),
    "--account",
    "acct_1",
    "--board",
    "board_1",
    "--workspace-repo",
    dir
  ], {
    env: { FIZZY_API_TOKEN: "token", FIZZY_API_URL: "https://app.fizzy.test" },
    clientFactories: {
      createFizzyClient() {
        return fakeSetupFizzy();
      }
    },
    runnerOptions: {
      versionProbe: async () => ({ ok: false, reason: "command_not_found", message: "spawn codex ENOENT" })
    }
  });

  assert.equal(result.exitCode, 2);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.code, "RUNNER_UNAVAILABLE");
  assert.match(payload.details.remediation, /Codex CLI/);
});

test("public validate reports missing Fizzy credentials with remediation", async () => {
  const dir = await setupWorkspace("fizzy-symphony-cli-validate-missing-token-");
  const configPath = await writeConfig(dir, { blankToken: true });

  const result = await runCli(["validate", "--config", configPath], {
    env: {}
  });

  assert.equal(result.exitCode, 2);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.code, "FIZZY_CREDENTIALS_MISSING");
  assert.match(payload.details.remediation, /FIZZY_API_TOKEN/);
});

test("public validate reports missing Codex runner as structured startup failure", async () => {
  const dir = await setupWorkspace("fizzy-symphony-cli-validate-missing-runner-");
  const configPath = await writeConfig(dir);

  const result = await runCli(["validate", "--config", configPath], {
    env: { FIZZY_API_TOKEN: "token" },
    clientFactories: {
      createFizzyClient() {
        return fakeValidationFizzy();
      }
    },
    runnerOptions: {
      versionProbe: async () => ({ ok: false, reason: "command_not_found", message: "spawn codex ENOENT" })
    }
  });

  assert.equal(result.exitCode, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.mode, "startup");
  assert.equal(payload.errors.at(-1).code, "RUNNER_DETECT_FAILED");
  assert.match(payload.errors.at(-1).details.remediation, /Codex CLI/);
});

async function runCli(args, options = {}) {
  let stdout = "";
  let stderr = "";
  const exitCode = await cliMain(args, {
    env: options.env ?? process.env,
    clientFactories: options.clientFactories,
    runnerOptions: options.runnerOptions,
    fetch: options.fetch,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } }
  });
  return { exitCode, stdout, stderr };
}

async function setupWorkspace(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  return dir;
}

async function writeConfig(dir, options = {}) {
  const configPath = join(dir, "config.yml");
  await writeAnnotatedConfig(configPath, {
    account: "acct",
    board: { id: "board_1", label: "Agents" },
    runnerPreferred: "cli_app_server",
    workspaceRepo: dir
  });

  if (options.noDispatch) {
    const text = await readFile(configPath, "utf8");
    await writeFile(configPath, text.replace(/no_dispatch: false/u, "no_dispatch: true"), "utf8");
  }
  if (options.blankToken) {
    const text = await readFile(configPath, "utf8");
    await writeFile(configPath, text.replace(/token: \$FIZZY_API_TOKEN/u, 'token: ""'), "utf8");
  }

  return configPath;
}

function fakeSetupFizzy() {
  const board = boardFixture();
  return {
    async getIdentity() {
      return { accounts: [{ id: "acct_1", name: "Team Account" }], user: { id: "user_1" } };
    },
    async listBoards() {
      return [board];
    },
    async listUsers() {
      return [{ id: "user_1", name: "Human" }];
    },
    async listTags() {
      return managedTags();
    },
    async getBoard() {
      return board;
    },
    async getEntropy() {
      return { warnings: [] };
    }
  };
}

function fakeValidationFizzy() {
  const board = boardFixture();
  return {
    async getIdentity() {
      return { accounts: [{ id: "acct", name: "Team Account" }], user: { id: "user_1" } };
    },
    async listUsers() {
      return [{ id: "user_1", name: "Human" }];
    },
    async listTags() {
      return managedTags();
    },
    async getBoard() {
      return board;
    },
    async getEntropy() {
      return { warnings: [] };
    }
  };
}

function fakeRunner(options = {}) {
  return {
    async detect(config) {
      options.calls?.push(["runner.detect", config.preferred]);
      return { kind: "cli_app_server", available: true, command: "codex" };
    },
    async validate(config) {
      options.calls?.push(["runner.validate", config.preferred]);
      return { ok: true, kind: "cli_app_server" };
    },
    async health(config) {
      options.calls?.push(["runner.health", config.preferred]);
      return options.health ?? { status: "ready", kind: "cli_app_server" };
    }
  };
}

function boardFixture() {
  return {
    id: "board_1",
    name: "Agents",
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
        tags: ["agent-instructions", "codex", "move-to-done"]
      }
    ]
  };
}

function managedTags() {
  return [
    { id: "tag_agent", name: "agent-instructions" },
    { id: "tag_codex", name: "codex" },
    { id: "tag_done", name: "move-to-done" }
  ];
}
