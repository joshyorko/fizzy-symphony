import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { main as cliMain } from "../bin/fizzy-symphony.js";
import {
  generateAnnotatedConfig,
  generateOperatorConfig,
  loadConfig,
  parseConfig,
  writeAnnotatedConfig,
  writeOperatorConfig
} from "../src/config.js";

function minimalConfig() {
  return {
    instance: { id: "instance-a", label: "local" },
    fizzy: {
      token: "$FIZZY_API_TOKEN",
      account: "acct",
      api_url: "https://app.fizzy.do",
      bot_user_id: ""
    },
    boards: {
      entries: [
        {
          id: "board_1",
          label: "Agents",
          enabled: true,
          routing_mode: "column_scoped",
          defaults: {
            backend: "codex",
            model: "",
            workspace: "app",
            persona: "repo-agent",
            unknown_managed_tag_policy: "fail",
            allowed_card_overrides: {
              backend: false,
              model: false,
              workspace: false,
              persona: false,
              priority: true,
              completion: false
            },
            concurrency: { max_concurrent: 1 }
          }
        }
      ]
    },
    server: {
      host: "127.0.0.1",
      port: "auto",
      port_allocation: "next_available",
      base_port: 4567,
      registry_dir: ".fizzy-symphony/run/instances",
      heartbeat_interval_ms: 5000
    },
    webhook: {
      enabled: false,
      path: "/webhook",
      secret: "",
      manage: false,
      managed_webhook_ids_by_board: {},
      callback_url: "",
      subscribed_actions: ["comment_created"]
    },
    polling: {
      interval_ms: 30000,
      use_etags: true,
      use_api_filters: true
    },
    agent: {
      max_concurrent: 1,
      max_concurrent_per_card: 1,
      turn_timeout_ms: 3600000,
      stall_timeout_ms: 300000,
      max_turns: 1,
      max_retry_backoff_ms: 300000,
      default_backend: "codex",
      default_model: "",
      reasoning_effort: "medium",
      default_persona: "repo-agent"
    },
    runner: {
      preferred: "cli_app_server",
      fallback: "cli_app_server",
      allow_fallback: true,
      sdk: { package: "", smoke_test: false },
      cli_app_server: { command: "codex", args: ["app-server"] },
      initialize_timeout_ms: 10000,
      request_timeout_ms: 60000,
      cancel_timeout_ms: 10000,
      stop_session_timeout_ms: 10000,
      terminate_timeout_ms: 5000,
      kill_timeout_ms: 2000,
      stream_timeout_ms: 3600000,
      max_stderr_bytes: 65536,
      health: { enabled: true, interval_ms: 60000 },
      codex: {
        approval_policy: {
          mode: "reject",
          sandbox_approval: "reject",
          command_approval: "reject",
          tool_approval: "reject",
          mcp_elicitation: "reject"
        },
        interactive: false,
        thread_sandbox: "workspace-write",
        turn_sandbox_policy: { type: "workspaceWrite" }
      }
    },
    workspaces: {
      root: ".fizzy-symphony/workspaces",
      metadata_root: ".fizzy-symphony/run/workspaces",
      default_isolation: "git_worktree",
      default_repo: ".",
      registry: {
        app: {
          repo: ".",
          isolation: "git_worktree",
          base_ref: "main",
          worktree_root: ".fizzy-symphony/worktrees",
          branch_prefix: "fizzy",
          workflow_path: "WORKFLOW.md",
          require_clean_source: true
        }
      },
      retry: { workspace_policy: "reuse" }
    },
    workflow: {
      create_starter_on_setup: false,
      fallback_enabled: false,
      fallback_path: ""
    },
    routing: {
      allow_postponed_cards: false,
      rerun: {
        mode: "explicit_tag_only",
        agent_rerun_consumption: "remove_when_supported"
      }
    },
    diagnostics: { no_dispatch: false },
    claims: {
      mode: "structured_comment",
      tag_visibility: false,
      tag: "agent-claimed",
      assign_on_claim: false,
      watch_on_claim: false,
      lease_ms: 900000,
      renew_interval_ms: 300000,
      steal_grace_ms: 30000,
      max_clock_skew_ms: 30000
    },
    completion: {
      allow_card_completion_override: false,
      markers: {
        mode: "structured_comment_and_tag",
        success_tag_prefix: "agent-completed",
        failure_tag_prefix: "agent-completion-failed"
      }
    },
    workpad: {
      enabled: true,
      mode: "single_comment",
      update_interval_ms: 30000
    },
    safety: {
      allowed_roots: [".", ".fizzy-symphony"],
      dirty_source_repo_policy: "fail",
      cleanup: {
        policy: "preserve",
        require_proof_before_cleanup: true,
        require_handoff_before_cleanup: true,
        forbid_force_remove: true,
        retention_ms: 604800000
      }
    },
    observability: {
      state_dir: ".fizzy-symphony/run",
      log_dir: ".fizzy-symphony/logs",
      status_snapshot_path: ".fizzy-symphony/run/status/latest.json",
      status_retention_ms: 604800000,
      log_format: "json"
    }
  };
}

test("generateAnnotatedConfig returns the full commented template with Task 1 fields", () => {
  const generated = generateAnnotatedConfig({
    account: "team",
    boards: [
      { id: "board_ready", label: "Ready Board" },
      { id: "board_docs", label: "Docs Board" }
    ],
    runnerPreferred: "cli_app_server"
  });

  assert.match(generated, /# fizzy-symphony config/);
  assert.match(generated, /Environment: FIZZY_API_TOKEN/);
  assert.match(generated, /server:/);
  assert.match(generated, /managed_webhook_ids_by_board/);
  assert.match(generated, /use_etags: true/);
  assert.match(generated, /workpad:/);
  assert.match(generated, /safety:/);
  assert.match(generated, /preferred: cli_app_server/);
  assert.match(generated, /id: board_ready/);
  assert.match(generated, /label: Ready Board/);
  assert.match(generated, /id: board_docs/);
  assert.match(generated, /label: Docs Board/);
  assert.match(generated, /secret: ""/);
});

test("generateAnnotatedConfig never writes raw webhook secrets and keeps webhook secret optional", () => {
  const generated = generateAnnotatedConfig({
    account: "team",
    board: { id: "board_ready", label: "Ready Board" },
    webhook: {
      manage: true,
      callback_url: "https://example.test/fizzy",
      secret: "do-not-write-me"
    }
  });

  assert.doesNotMatch(generated, /do-not-write-me/);
  assert.match(generated, /secret: ""/);
  assert.match(generated, /callback_url: https:\/\/example.test\/fizzy/);
});

test("generateOperatorConfig writes a compact user-facing config with the Codex model visible", async () => {
  const generated = generateOperatorConfig({
    account: "team",
    apiUrl: "https://fizzy.example.test",
    boards: [{ id: "board_ready", label: "Ready Board" }],
    runnerPreferred: "cli_app_server",
    defaultModel: "gpt-5.4",
    reasoningEffort: "high",
    workspaceRepo: "."
  });

  assert.match(generated, /# fizzy-symphony/u);
  assert.match(generated, /account: team/u);
  assert.match(generated, /api_url: https:\/\/fizzy\.example\.test/u);
  assert.match(generated, /id: board_ready/u);
  assert.match(generated, /default_model: gpt-5\.4/u);
  assert.match(generated, /reasoning_effort: high/u);
  assert.match(generated, /fallback_enabled: true/u);
  assert.match(generated, /allowed_roots:/u);
  assert.match(generated, /ignored_dirty_paths:/u);
  assert.match(generated, /\.fizzy-symphony\//u);
  assert.doesNotMatch(generated, /heartbeat_interval_ms/u);
  assert.doesNotMatch(generated, /terminate_timeout_ms/u);

  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-compact-config-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");
  await writeOperatorConfig(configPath, {
    account: "team",
    apiUrl: "https://fizzy.example.test",
    boards: [{ id: "board_ready", label: "Ready Board" }],
    runnerPreferred: "cli_app_server",
    defaultModel: "gpt-5.4",
    reasoningEffort: "high",
    workspaceRepo: dir
  });

  const loaded = await loadConfig(configPath, { env: { FIZZY_API_TOKEN: "x" } });
  assert.equal(loaded.agent.default_model, "gpt-5.4");
  assert.equal(loaded.agent.reasoning_effort, "high");
  assert.equal(loaded.boards.entries[0].defaults.model, "gpt-5.4");
  assert.equal(loaded.workflow.fallback_enabled, true);
  assert.deepEqual(loaded.safety.ignored_dirty_paths, [".fizzy-symphony/"]);
  assert.equal(loaded.safety.allowed_roots.includes(dir), true);
  assert.equal(loaded.observability.state_dir, join(dir, ".fizzy-symphony", "run"));
  assert.equal(loaded.server.registry_dir, join(dir, ".fizzy-symphony", "run", "instances"));
  assert.equal(loaded.runner.preferred, "cli_app_server");
  assert.equal(loaded.server.base_port, 4567);
});

test("generateOperatorConfig hard-pins the default Codex model and reasoning effort", async () => {
  const generated = generateOperatorConfig({
    account: "team",
    boards: [{ id: "board_ready", label: "Ready Board" }],
    runnerPreferred: "cli_app_server",
    workspaceRepo: "."
  });

  assert.match(generated, /default_model: gpt-5\.5/u);
  assert.match(generated, /reasoning_effort: medium/u);

  const parsed = parseConfig({
    fizzy: { token: "$FIZZY_API_TOKEN", account: "team" },
    boards: { entries: [{ id: "board_ready" }] }
  }, {
    configPath: "/tmp/config.yml",
    env: { FIZZY_API_TOKEN: "x" }
  });

  assert.equal(parsed.agent.default_model, "gpt-5.5");
  assert.equal(parsed.agent.reasoning_effort, "medium");
  assert.equal(parsed.boards.entries[0].defaults.model, "gpt-5.5");
});

test("writeAnnotatedConfig creates parent directories and writes the generated template", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-config-"));
  const configPath = join(dir, ".fizzy-symphony", "config.yml");

  await writeAnnotatedConfig(configPath, {
    account: "acct",
    board: { id: "board_2", label: "Agents" }
  });

  const written = await readFile(configPath, "utf8");
  assert.match(written, /account: acct/);
  assert.match(written, /id: board_2/);
});

test("parseConfig resolves explicit environment indirection and relative paths from config file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-parse-"));
  const config = minimalConfig();

  const parsed = parseConfig(config, {
    configPath: join(dir, "nested", "config.json"),
    env: { FIZZY_API_TOKEN: "secret-token" }
  });

  assert.equal(parsed.fizzy.token, "secret-token");
  assert.equal(parsed.workspaces.root, join(dir, "nested", ".fizzy-symphony", "workspaces"));
  assert.equal(parsed.workspaces.registry.app.repo, join(dir, "nested"));
  assert.equal(parsed.observability.status_snapshot_path, join(dir, "nested", ".fizzy-symphony", "run", "status", "latest.json"));
});

test("parseConfig fails missing referenced environment values with a structured code", () => {
  const config = minimalConfig();

  assert.throws(
    () => parseConfig(config, { configPath: "/tmp/config.json", env: {} }),
    (error) => error.code === "CONFIG_MISSING_ENV" && error.details.variable === "FIZZY_API_TOKEN"
  );
});

test("parseConfig rejects unknown top-level and nested fields", () => {
  assert.throws(
    () => parseConfig({ ...minimalConfig(), surprise: true }, { configPath: "/tmp/config.json", env: { FIZZY_API_TOKEN: "x" } }),
    (error) => error.code === "CONFIG_UNKNOWN_KEY" && error.details.path === "surprise"
  );

  const config = minimalConfig();
  config.runner.codex.unexpected = true;

  assert.throws(
    () => parseConfig(config, { configPath: "/tmp/config.json", env: { FIZZY_API_TOKEN: "x" } }),
    (error) => error.code === "CONFIG_UNKNOWN_KEY" && error.details.path === "runner.codex.unexpected"
  );
});

test("parseConfig rejects Task 1 enum, duration, port, and managed webhook cross-field errors", () => {
  const env = { FIZZY_API_TOKEN: "x" };
  const cases = [
    {
      code: "CONFIG_INVALID_ENUM",
      mutate: (config) => { config.safety.cleanup.policy = "delete_everything"; }
    },
    {
      code: "CONFIG_INVALID_ENUM",
      mutate: (config) => { config.claims.mode = "tag_only"; }
    },
    {
      code: "CONFIG_INVALID_ENUM",
      mutate: (config) => { config.runner.preferred = "python_sdk"; }
    },
    {
      code: "CONFIG_INVALID_ENUM",
      mutate: (config) => { config.runner.fallback = "sdk"; }
    },
    {
      code: "CONFIG_INVALID_ENUM",
      mutate: (config) => { config.agent.reasoning_effort = "overthink"; }
    },
    {
      code: "CONFIG_INVALID_SERVER_PORT",
      mutate: (config) => { config.server.port = 70000; }
    },
    {
      code: "CONFIG_INVALID_SERVER_PORT",
      mutate: (config) => {
        config.server.port = "auto";
        config.server.port_allocation = "fixed";
      }
    },
    {
      code: "CONFIG_INVALID_SERVER_PORT",
      mutate: (config) => {
        config.server.port = 4567;
        config.server.port_allocation = "random";
      }
    },
    {
      code: "CONFIG_INVALID_DURATION",
      mutate: (config) => { config.polling.interval_ms = 0; }
    },
    {
      code: "CONFIG_INVALID_WEBHOOK",
      mutate: (config) => {
        config.webhook.manage = true;
        config.webhook.callback_url = "";
      }
    },
    {
      code: "CONFIG_UNIMPLEMENTED_FEATURE",
      mutate: (config) => { config.agent.max_turns = 2; }
    },
    {
      code: "CONFIG_UNIMPLEMENTED_FEATURE",
      mutate: (config) => { config.workspaces.default_isolation = "git_clone"; }
    },
    {
      code: "CONFIG_UNIMPLEMENTED_FEATURE",
      mutate: (config) => { config.workspaces.registry.app.isolation = "copy"; }
    },
    {
      code: "CONFIG_INVALID_ENUM",
      mutate: (config) => { config.workspaces.default_isolation = "empty_directory"; }
    },
    {
      code: "CONFIG_INVALID_ENUM",
      mutate: (config) => { config.workspaces.registry.app.isolation = "empty_directory"; }
    }
  ];

  for (const { code, mutate } of cases) {
    const config = minimalConfig();
    mutate(config);
    assert.throws(
      () => parseConfig(config, { configPath: "/tmp/config.json", env }),
      (error) => error.code === code
    );
  }
});

test("loadConfig reads JSON and generated YAML config files for the CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-load-"));
  const jsonPath = join(dir, "config.json");
  const yamlPath = join(dir, "config.yml");

  await writeFile(jsonPath, JSON.stringify(minimalConfig()), "utf8");
  await writeAnnotatedConfig(yamlPath, {
    account: "acct",
    board: { id: "board_1", label: "Agents" },
    runnerPreferred: "cli_app_server"
  });

  const loaded = await loadConfig(jsonPath, { env: { FIZZY_API_TOKEN: "x" } });
  const loadedYaml = await loadConfig(yamlPath, {
    env: { FIZZY_API_TOKEN: "x" }
  });

  assert.equal(loaded.fizzy.token, "x");
  assert.equal(loadedYaml.fizzy.account, "acct");
  assert.equal(loadedYaml.boards.entries[0].id, "board_1");
  assert.equal(loadedYaml.runner.preferred, "cli_app_server");
  assert.equal(loadedYaml.webhook.secret, "");
});

test("CLI exposes setup template generation and parse-only validation commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-"));
  const templatePath = join(dir, "config.yml");
  const jsonPath = join(dir, "config.json");

  const setup = await runCli([
    "setup",
    "--template-only",
    "--config",
    templatePath
  ]);
  assert.equal(setup.exitCode, 0);
  assert.match(setup.stdout, /wrote annotated config/i);
  assert.match(await readFile(templatePath, "utf8"), /# fizzy-symphony config/);

  await writeFile(jsonPath, JSON.stringify(minimalConfig()), "utf8");
  const validate = await runCli([
    "validate",
    "--parse-only",
    "--config",
    jsonPath
  ], {
    env: { ...process.env, FIZZY_API_TOKEN: "token" }
  });
  assert.equal(validate.exitCode, 0);
  assert.deepEqual(JSON.parse(validate.stdout), { ok: true, mode: "parse-only" });

});

test("CLI setup runs the live injected-client setup path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-cli-live-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const configPath = join(dir, "config.yml");

  const setup = await runCli([
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
    env: { ...process.env, FIZZY_API_TOKEN: "token" },
    fizzy: fakeLiveSetupFizzy(),
    runner: fakeLiveSetupRunner()
  });

  assert.equal(setup.exitCode, 0);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.account, "acct_1");
  assert.deepEqual(payload.boards, ["board_1"]);
  assert.match(await readFile(configPath, "utf8"), /id: board_1/);
});

async function runCli(args, options = {}) {
  let stdout = "";
  let stderr = "";
  const exitCode = await cliMain(args, {
    env: options.env ?? process.env,
    fizzy: options.fizzy,
    runner: options.runner,
    prompts: options.prompts,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } }
  });
  return { exitCode, stdout, stderr };
}

function fakeLiveSetupFizzy() {
  const board = {
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
      return [
        { id: "tag_agent", name: "agent-instructions" },
        { id: "tag_codex", name: "codex" },
        { id: "tag_done", name: "move-to-done" }
      ];
    },
    async getBoard() {
      return board;
    },
    async getEntropy() {
      return { warnings: [] };
    }
  };
}

function fakeLiveSetupRunner() {
  return {
    async detect() {
      return { kind: "cli_app_server", available: true, command: "codex" };
    }
  };
}

export { minimalConfig };
