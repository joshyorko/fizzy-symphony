import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { main as cliMain } from "../bin/fizzy-symphony.js";
import { stripAnsi } from "../src/cli-opener.js";
import { writeAnnotatedConfig } from "../src/config.js";

const CLI_PATH = fileURLToPath(new URL("../bin/fizzy-symphony.js", import.meta.url));

test("public setup creates a starter workflow, starter board config, and human next steps when explicitly requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-init-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  const calls = [];

  await assert.rejects(() => access(join(dir, "WORKFLOW.md")), { code: "ENOENT" });
  await writeFile(join(dir, ".env"), "FIZYY_TOKEN=token-from-local-env\n", "utf8");

  const result = await runCli([
    "setup",
    "--config",
    configPath,
    "--workspace-repo",
    dir,
    "--create-starter-workflow",
    "--api-url",
    "https://fizzy.example.test"
  ], {
    env: {},
    clientFactories: {
      createFizzyClient({ config }) {
        calls.push(["createFizzyClient", config.fizzy.api_url, Boolean(config.fizzy.token)]);
        return fakeStarterSetupFizzy();
      },
      createRunner({ config }) {
        calls.push(["createRunner", config.runner?.preferred ?? "cli_app_server"]);
        return fakeRunner();
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const plainStdout = stripAnsi(result.stdout);
  assert.match(plainStdout, /FIZZY SYMPHONY/u);
  assert.equal(plainStdout.indexOf("FIZZY SYMPHONY") < plainStdout.indexOf("fizzy-symphony is ready"), true);
  assert.match(result.stdout, /fizzy-symphony is ready/u);
  assert.match(result.stdout, /fizzy-symphony start --config/u);
  assert.match(result.stdout, /Create a normal Fizzy card in Ready for Agents/u);
  assert.deepEqual(calls, [
    ["createFizzyClient", "https://fizzy.example.test", true],
    ["createRunner", "cli_app_server"]
  ]);

  const workflow = await readFile(join(dir, "WORKFLOW.md"), "utf8");
  assert.match(workflow, /Repository workflow/u);
  assert.match(workflow, /Fizzy card and golden-ticket instructions/u);
  assert.doesNotMatch(workflow, /npm test/u);

  const generatedConfig = await readFile(configPath, "utf8");
  assert.match(generatedConfig, /id: starter_board/u);
  assert.match(generatedConfig, /api_url: https:\/\/fizzy\.example\.test/u);
});

test("public init delegates to setup with a deprecation warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-init-deprecated-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  await writeFile(join(dir, ".env"), "FIZYY_TOKEN=token-from-local-env\n", "utf8");

  const result = await runCli([
    "init",
    "--config",
    configPath,
    "--workspace-repo",
    dir,
    "--create-starter-workflow",
    "--api-url",
    "https://fizzy.example.test"
  ], {
    env: {},
    clientFactories: {
      createFizzyClient() {
        return fakeStarterSetupFizzy();
      },
      createRunner() {
        return fakeRunner();
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stderr, /deprecated/u);
  assert.match(result.stderr, /fizzy-symphony setup/u);
  assert.match(stripAnsi(result.stdout), /fizzy-symphony is ready/u);
});

test("public setup defaults to the guided starter flow when no existing board is selected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-setup-guided-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");

  const result = await runCli([
    "setup",
    "--config",
    configPath,
    "--workspace-repo",
    dir,
    "--model",
    "gpt-5.4",
    "--reasoning-effort",
    "high",
    "--max-agents",
    "3",
    "--api-url",
    "https://fizzy.example.test",
    "--token",
    "token-from-cli"
  ], {
    env: { TERM: "dumb" },
    clientFactories: {
      createFizzyClient() {
        return fakeStarterSetupFizzy();
      },
      createRunner() {
        return fakeRunner();
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const plainStdout = stripAnsi(result.stdout);
  assert.match(plainStdout, /FIZZY SYMPHONY/u);
  assert.match(plainStdout, /fizzy-symphony is ready/u);
  assert.match(plainStdout, /fizzy-symphony start --config/u);
  assert.match(plainStdout, /Model\s+gpt-5\.4/u);
  assert.match(plainStdout, /Reasoning\s+high/u);
  assert.match(plainStdout, /Max agents\s+3/u);

  await assert.rejects(() => access(join(dir, "WORKFLOW.md")), { code: "ENOENT" });

  const generatedConfig = await readFile(configPath, "utf8");
  assert.match(generatedConfig, /id: starter_board/u);
  assert.match(generatedConfig, /api_url: https:\/\/fizzy\.example\.test/u);
  assert.match(generatedConfig, /default_model: gpt-5\.4/u);
  assert.match(generatedConfig, /reasoning_effort: high/u);
  assert.match(generatedConfig, /max_concurrent: 3/u);
  assert.match(generatedConfig, /fallback_enabled: true/u);
  assert.doesNotMatch(generatedConfig, /terminate_timeout_ms/u);
});

test("guided setup can ask for model, reasoning, max agents, and workspace mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-setup-default-prompts-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  const prompts = [];

  const result = await runCli([
    "setup",
    "--config",
    configPath,
    "--workspace-repo",
    dir,
    "--api-url",
    "https://fizzy.example.test",
    "--token",
    "token-from-cli"
  ], {
    env: { TERM: "dumb" },
    prompts: {
      async configureSetupDefaults(defaults) {
        prompts.push(defaults);
        return {
          defaultModel: "gpt-5.5",
          reasoningEffort: "xhigh",
          maxAgents: 4,
          workspaceMode: "no_dispatch"
        };
      }
    },
    clientFactories: {
      createFizzyClient() {
        return fakeStarterSetupFizzy();
      },
      createRunner() {
        return fakeRunner();
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].defaultModel, "gpt-5.5");
  assert.equal(prompts[0].reasoningEffort, "medium");
  assert.equal(prompts[0].maxAgents, 1);
  assert.equal(prompts[0].workspaceMode, "protected_worktree");

  const plainStdout = stripAnsi(result.stdout);
  assert.match(plainStdout, /Reasoning\s+xhigh/u);
  assert.match(plainStdout, /Max agents\s+4/u);
  assert.match(plainStdout, /Workspace\s+no dispatch/u);

  const generatedConfig = await readFile(configPath, "utf8");
  assert.match(generatedConfig, /default_model: gpt-5\.5/u);
  assert.match(generatedConfig, /reasoning_effort: xhigh/u);
  assert.match(generatedConfig, /max_concurrent: 4/u);
  assert.match(generatedConfig, /diagnostics:/u);
  assert.match(generatedConfig, /no_dispatch: true/u);
});

test("public setup does not require or create WORKFLOW.md without an explicit workflow flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-setup-no-workflow-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");

  const result = await runCli([
    "setup",
    "--config",
    configPath,
    "--workspace-repo",
    dir,
    "--api-url",
    "https://fizzy.example.test",
    "--token",
    "token-from-cli"
  ], {
    env: { TERM: "dumb" },
    clientFactories: {
      createFizzyClient() {
        return fakeStarterSetupFizzy();
      },
      createRunner() {
        return fakeRunner();
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  await assert.rejects(() => access(join(dir, "WORKFLOW.md")), { code: "ENOENT" });
  const generatedConfig = await readFile(configPath, "utf8");
  assert.match(generatedConfig, /fallback_enabled: true/u);
  assert.match(generatedConfig, /ignored_dirty_paths:/u);
});

test("guided setup prompt skips missing WORKFLOW.md by default and still creates the starter board", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-setup-workflow-prompt-skip-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  const prompts = [];
  const createCalls = [];
  const fizzy = fakeStarterSetupFizzy();
  const createBoard = fizzy.createBoard;
  fizzy.createBoard = async (request) => {
    createCalls.push(request);
    return createBoard(request);
  };

  const result = await runCli([
    "setup",
    "--config",
    configPath,
    "--workspace-repo",
    dir,
    "--api-url",
    "https://fizzy.example.test",
    "--token",
    "token-from-cli"
  ], {
    env: { TERM: "dumb" },
    prompts: {
      async input(prompt) {
        prompts.push(prompt);
        if (prompt.name === "setup_mutation_review") return "yes";
        return "";
      }
    },
    clientFactories: {
      createFizzyClient() {
        return fizzy;
      },
      createRunner() {
        return fakeRunner();
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(
    prompts.map((prompt) => [prompt.name, prompt.defaultValue]),
    [["workflow_action", "skip"], ["setup_mutation_review", "no"]]
  );
  assert.equal(createCalls.length, 1);
  await assert.rejects(() => access(join(dir, "WORKFLOW.md")), { code: "ENOENT" });
  assert.match(await readFile(configPath, "utf8"), /id: starter_board/u);
});

test("guided setup shows the opener and human remediation before missing credential failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-setup-missing-token-"));
  const result = await runCli([
    "setup",
    "--config",
    join(dir, ".fizzy-symphony", "config.yml"),
    "--workspace-repo",
    dir,
    "--api-url",
    "https://fizzy.example.test"
  ], {
    env: { TERM: "dumb" }
  });

  assert.equal(result.exitCode, 2);
  assert.match(stripAnsi(result.stdout), /FIZZY SYMPHONY/u);
  assert.doesNotMatch(result.stderr, /^\{/u);
  assert.match(result.stderr, /Fizzy API credentials/u);
  assert.match(result.stderr, /\.env/u);
});

test("guided setup can prompt for missing Fizzy URL and token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-setup-prompts-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  const prompts = [];

  const result = await runCli([
    "setup",
    "--config",
    configPath,
    "--workspace-repo",
    dir,
    "--create-starter-workflow"
  ], {
    env: { TERM: "dumb" },
    prompts: {
      async input(prompt) {
        prompts.push(prompt.name);
        if (prompt.name === "fizzy_api_url") return "https://prompted.fizzy.test";
        if (prompt.name === "fizzy_api_token") return "prompted-token";
        if (prompt.name === "setup_mutation_review") return "yes";
        return "";
      }
    },
    clientFactories: {
      createFizzyClient({ config }) {
        assert.equal(config.fizzy.api_url, "https://prompted.fizzy.test");
        assert.equal(config.fizzy.token, "prompted-token");
        return fakeStarterSetupFizzy();
      },
      createRunner() {
        return fakeRunner();
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(prompts, ["fizzy_api_url", "fizzy_api_token", "setup_mutation_review"]);
  assert.match(await readFile(configPath, "utf8"), /api_url: https:\/\/prompted\.fizzy\.test/u);
});

test("guided setup uses terminal prompts for mutation review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-setup-terminal-prompts-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  const stdin = new PassThrough();
  stdin.isTTY = true;
  setImmediate(() => stdin.write("yes\n"));

  const result = await runCli([
    "setup",
    "--config",
    configPath,
    "--workspace-repo",
    dir,
    "--create-starter-workflow",
    "--api-url",
    "https://fizzy.example.test",
    "--token",
    "token-from-cli"
  ], {
    env: { TERM: "xterm-256color" },
    stdin,
    stdoutIsTTY: true,
    clientFactories: {
      createFizzyClient() {
        return fakeStarterSetupFizzy();
      },
      createRunner() {
        return fakeRunner();
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(stripAnsi(result.stdout), /Review setup changes/u);
  assert.match(await readFile(configPath, "utf8"), /id: starter_board/u);
});

test("public help exits successfully", async () => {
  for (const flag of ["--help", "-h"]) {
    const result = await runCli([flag], { env: {} });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Usage:/u);
    assert.match(result.stdout, /--max-agents n/u);
    assert.match(result.stdout, /--reasoning-effort level/u);
    assert.doesNotMatch(result.stdout, /fizzy-symphony init/u);
    assert.match(result.stdout, /fizzy-symphony dashboard/u);
    assert.match(result.stdout, /fizzy-symphony start/u);
  }
});

test("public dashboard delegates to status-backed dashboard command", async () => {
  const result = await runCli(["dashboard", "--endpoint", "http://127.0.0.1:4567", "--once"], {
    env: {},
    fetch: async () => ({
      ok: true,
      json: async () => ({
        instance: { id: "instance-a" },
        readiness: { ready: true },
        runner_health: { status: "ready", kind: "cli_app_server" },
        watched_boards: [],
        routes: [],
        active_runs: [],
        claims: [],
        workpads: [],
        recent_failures: [],
        recent_completions: [],
        validation: { warnings: [], errors: [] }
      })
    })
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /fizzy-symphony dashboard/u);
  assert.match(result.stdout, /Instance: instance-a/u);
});

test("bare command opens dashboard when config exists", async () => {
  const dir = await setupWorkspace("fizzy-symphony-cli-bare-dashboard-");
  const configPath = await writeConfig(dir);

  const result = await runCli(["--config", configPath, "--endpoint", "http://127.0.0.1:4567", "--once"], {
    env: {},
    fetch: async () => ({
      ok: true,
      json: async () => ({
        instance: { id: "instance-a" },
        readiness: { ready: true },
        runner_health: { status: "ready", kind: "cli_app_server" },
        watched_boards: [],
        routes: [],
        active_runs: [],
        claims: [],
        workpads: [],
        recent_failures: [],
        recent_completions: [],
        validation: { warnings: [], errors: [] }
      })
    })
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /fizzy-symphony dashboard/u);
});

test("bare command rejects unknown leading flags instead of entering setup", async () => {
  const result = await runCli(["--bad"], {
    env: {},
    clientFactories: {
      createFizzyClient() {
        throw new Error("unknown bare flag should not construct clients");
      },
      createRunner() {
        throw new Error("unknown bare flag should not construct clients");
      }
    }
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /Usage:/u);
  assert.equal(result.stderr, "");
});

test("public executable runs when invoked through a symlink path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-symlink-"));
  const linkedCli = join(dir, "fizzy-symphony.js");
  await symlink(CLI_PATH, linkedCli);

  const result = spawnSync(process.execPath, [linkedCli, "--help"], {
    encoding: "utf8",
    env: {}
  });

  if (result.error?.code === "EPERM") return;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/u);
  assert.match(result.stdout, /fizzy-symphony setup/u);
});

test("public init animates the opener on an interactive terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-init-tty-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");

  await writeFile(join(dir, ".env"), "FIZZY_API_TOKEN=token-from-local-env\n", "utf8");

  const result = await runCli([
    "init",
    "--config",
    configPath,
    "--workspace-repo",
    dir,
    "--create-starter-workflow",
    "--api-url",
    "https://fizzy.example.test"
  ], {
    env: { TERM: "xterm-256color", FIZZY_SYMPHONY_ANIM: "paint" },
    stdoutIsTTY: true,
    openerFrameDelayMs: 0,
    clientFactories: {
      createFizzyClient() {
        return fakeStarterSetupFizzy();
      },
      createRunner() {
        return fakeRunner();
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  const plainStdout = stripAnsi(result.stdout);
  assert.match(result.stdout, /\x1b\[\d+A/u);
  assert.match(plainStdout, /FIZZY SYMPHONY/u);
  assert.match(plainStdout, /GOLDEN TICKET/u);
  assert.match(plainStdout, /fizzy-symphony is ready/u);
});

test("public init keeps dumb terminals static", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-init-dumb-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");

  await writeFile(join(dir, ".env"), "FIZZY_API_TOKEN=token-from-local-env\n", "utf8");

  const result = await runCli([
    "init",
    "--config",
    configPath,
    "--workspace-repo",
    dir,
    "--create-starter-workflow",
    "--api-url",
    "https://fizzy.example.test"
  ], {
    env: { TERM: "dumb", FIZZY_SYMPHONY_ANIM: "pop" },
    stdoutIsTTY: true,
    openerFrameDelayMs: 0,
    clientFactories: {
      createFizzyClient() {
        return fakeStarterSetupFizzy();
      },
      createRunner() {
        return fakeRunner();
      }
    }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\x1b\[\d+A/u);
  assert.doesNotMatch(result.stdout, /\x1b\[/u);
  assert.match(stripAnsi(result.stdout), /FIZZY SYMPHONY/u);
  assert.match(result.stdout, /fizzy-symphony is ready/u);
});

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
  const generatedConfig = await readFile(configPath, "utf8");
  assert.match(generatedConfig, /id: board_1/);
  assert.match(generatedConfig, /api_url: https:\/\/app\.fizzy\.test/);
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
    "--mode",
    "existing",
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
    "--mode",
    "existing",
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
    prompts: options.prompts,
    clientFactories: options.clientFactories,
    runnerOptions: options.runnerOptions,
    fetch: options.fetch,
    openerFrameDelayMs: options.openerFrameDelayMs,
    stdin: options.stdin ?? { isTTY: options.stdinIsTTY ?? false },
    stdout: {
      isTTY: options.stdoutIsTTY ?? false,
      columns: 80,
      write: (chunk) => { stdout += chunk; },
      on() { return this; },
      off() { return this; },
      removeListener() { return this; }
    },
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
    async getBoard(_boardId, options = {}) {
      assert.equal(options.account, "acct_1");
      return board;
    },
    async getEntropy() {
      return { warnings: [] };
    }
  };
}

function fakeStarterSetupFizzy() {
  const board = {
    id: "starter_board",
    name: "Agent Playground: cli-init",
    columns: [],
    cards: []
  };

  return {
    async getIdentity() {
      return { accounts: [{ id: "acct_1", name: "Team Account" }], user: { id: "user_1" } };
    },
    async listBoards() {
      return [];
    },
    async listUsers() {
      return [{ id: "user_1", name: "Human" }];
    },
    async listTags() {
      return managedTags();
    },
    async createBoard(request) {
      board.name = request.name;
      return { id: board.id, name: board.name };
    },
    async createColumn(request) {
      const column = {
        id: request.name === "Ready for Agents" ? "starter_ready" : "starter_done",
        name: request.name
      };
      board.columns.push(column);
      return column;
    },
    async createCard(request) {
      const card = {
        id: "starter_golden",
        number: 100,
        title: request.title,
        golden: false,
        column_id: "maybe",
        description: request.description,
        tags: []
      };
      board.cards.push(card);
      return card;
    },
    async toggleTag(request) {
      const card = board.cards.find((candidate) => candidate.number === request.card_number || candidate.id === request.card_id);
      const tag = request.tag_title ?? request.tagTitle ?? request.tag;
      if (card && tag && !card.tags.includes(tag)) card.tags.push(tag);
      return { ok: true };
    },
    async moveCardToColumn(request) {
      const card = board.cards.find((candidate) => candidate.number === request.card_number || candidate.id === request.card_id);
      if (card) card.column_id = request.column_id;
      return { ok: true };
    },
    async markGolden() {
      board.cards[0].golden = true;
      return { ok: true };
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
