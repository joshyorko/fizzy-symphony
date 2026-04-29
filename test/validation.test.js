import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createCompletionFailureMarker,
  discoverGoldenTicketRoutes,
  normalizeTag,
  parseCompletionFailureMarker,
  validateStartup
} from "../src/validation.js";
import { parseConfig } from "../src/config.js";

function minimalConfig() {
  return {
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
          enabled: true,
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
            }
          }
        }
      ]
    },
    server: { port: "auto", base_port: 4567 },
    webhook: { manage: false, callback_url: "", secret: "" },
    claims: { mode: "structured_comment", assign_on_claim: false, watch_on_claim: false },
    safety: {
      cleanup: {
        policy: "preserve",
        require_proof_before_cleanup: true,
        require_handoff_before_cleanup: true,
        forbid_force_remove: true
      }
    },
    workspaces: {
      registry: {
        app: {
          repo: ".",
          workflow_path: "WORKFLOW.md"
        }
      }
    },
    workflow: { fallback_enabled: false },
    runner: {
      preferred: "cli_app_server",
      fallback: "cli_app_server",
      cli_app_server: { command: "codex" }
    },
    diagnostics: { no_dispatch: false },
    routing: { rerun: { mode: "explicit_tag_only" } }
  };
}

function board(overrides = {}) {
  return {
    id: "board_1",
    name: "Agents",
    columns: [
      { id: "col_ready", name: "Ready for Agents" },
      { id: "col_review", name: "Review" },
      { id: "col_done", name: "Done" }
    ],
    cards: [
      {
        id: "golden_ready",
        title: "Ready Route",
        golden: true,
        column_id: "col_ready",
        tags: ["#agent-instructions", "codex", "backend-codex", "workspace-app", "model-gpt-5", "persona-repo-agent", "move-to-done"]
      }
    ],
    entropy: { auto_postpone_enabled: false },
    ...overrides
  };
}

function fakeFizzy({
  identityError = false,
  boards = [board()],
  users = [{ id: "bot_1" }],
  tags = [
    { id: "tag_agent", name: "agent-instructions" },
    { id: "tag_codex", name: "backend-codex" },
    { id: "tag_codex_alias", name: "codex" },
    { id: "tag_done", name: "move-to-done" },
    { id: "tag_workspace", name: "workspace-app" },
    { id: "tag_model", name: "model-gpt-5" },
    { id: "tag_persona", name: "persona-repo-agent" }
  ]
} = {}) {
  const calls = [];
  return {
    calls,
    async getIdentity() {
      calls.push(["getIdentity"]);
      if (identityError) throw new Error("invalid");
      return { accounts: [{ id: "acct", name: "Account" }], user: { id: "user_1" } };
    },
    async listUsers() {
      calls.push(["listUsers"]);
      return users;
    },
    async listTags() {
      calls.push(["listTags"]);
      return tags;
    },
    async getBoard(boardId) {
      calls.push(["getBoard", boardId]);
      const found = boards.find((candidate) => candidate.id === boardId);
      if (!found) throw new Error(`missing board ${boardId}`);
      return found;
    },
    async getEntropy() {
      calls.push(["getEntropy"]);
      return { warnings: [{ code: "ENTROPY_UNKNOWN", message: "Entropy settings not visible" }] };
    }
  };
}

function fakeRunner(health = { status: "ready", kind: "cli_app_server" }) {
  return {
    async detect() {
      return { kind: "cli_app_server", available: true };
    },
    async validate() {
      return { ok: true, kind: "cli_app_server" };
    },
    async health() {
      return health;
    }
  };
}

async function parsedConfig(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-validation-"));
  await writeFile(join(dir, "WORKFLOW.md"), "# Workflow\n", "utf8");
  const source = minimalConfig();
  Object.assign(source, overrides);
  return {
    config: parseConfig(source, {
      configPath: join(dir, "config.json"),
      env: { FIZZY_API_TOKEN: "token" }
    }),
    dir
  };
}

function errorCodes(report) {
  return report.errors.map((error) => error.code);
}

test("normalizeTag trims, removes leading hash, and compares case-insensitively", () => {
  assert.equal(normalizeTag(" #Agent-Instructions "), "agent-instructions");
  assert.equal(normalizeTag({ name: "#MOVE-To-Done" }), "move-to-done");
});

test("validateStartup resolves IDs for managed tags used by golden-ticket routes", async () => {
  const { config } = await parsedConfig();

  const report = await validateStartup({
    config,
    fizzy: fakeFizzy(),
    runner: fakeRunner()
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.resolvedTags["agent-instructions"], { id: "tag_agent", name: "agent-instructions" });
  assert.deepEqual(report.resolvedTags["move-to-done"], { id: "tag_done", name: "move-to-done" });
});

test("validateStartup applies board-specific route defaults across multiple boards", async () => {
  const { config } = await parsedConfig();
  config.boards.entries.push({
    id: "board_2",
    enabled: true,
    defaults: {
      backend: "codex",
      model: "gpt-board-two",
      workspace: "docs",
      persona: "docs-agent",
      unknown_managed_tag_policy: "fail",
      allowed_card_overrides: {
        backend: false,
        model: false,
        workspace: false,
        persona: false,
        priority: true,
        completion: false
      }
    }
  });

  const boardOne = board({
    cards: [{ id: "golden_1", title: "One", golden: true, column_id: "col_ready", tags: ["agent-instructions", "close-on-complete"] }]
  });
  const boardTwo = board({
    id: "board_2",
    cards: [{ id: "golden_2", title: "Two", golden: true, column_id: "col_ready", tags: ["agent-instructions", "close-on-complete"] }]
  });

  const report = await validateStartup({
    config,
    fizzy: fakeFizzy({
      boards: [boardOne, boardTwo],
      tags: [
        { id: "tag_agent", name: "agent-instructions" },
        { id: "tag_close", name: "close-on-complete" }
      ]
    }),
    runner: fakeRunner()
  });

  assert.equal(report.ok, true);
  const byBoard = new Map(report.routes.map((route) => [route.board_id, route]));
  assert.equal(byBoard.get("board_1").workspace, "app");
  assert.equal(byBoard.get("board_2").workspace, "docs");
  assert.equal(byBoard.get("board_2").model, "gpt-board-two");
  assert.equal(byBoard.get("board_2").persona, "docs-agent");
});

test("validateStartup lists tags and fails when agent-instructions cannot be resolved", async () => {
  const { config } = await parsedConfig();
  const fizzy = fakeFizzy({ tags: [{ id: "tag_codex", name: "backend-codex" }] });

  const report = await validateStartup({
    config,
    fizzy,
    runner: fakeRunner()
  });

  assert.equal(report.ok, false);
  assert.ok(errorCodes(report).includes("MANAGED_TAG_NOT_FOUND"));
  assert.ok(fizzy.calls.some((call) => call[0] === "listTags"));
});

test("validateStartup rejects SDK runner without an exact package and contract", async () => {
  const { config } = await parsedConfig();
  config.runner.preferred = "sdk";
  config.runner.sdk = { package: "@openai/codex" };
  config.runner.allow_fallback = false;

  const report = await validateStartup({
    config,
    fizzy: fakeFizzy(),
    runner: fakeRunner()
  });

  assert.equal(report.ok, false);
  assert.ok(errorCodes(report).includes("INVALID_RUNNER"));
});

test("validateStartup rejects arbitrary non-empty SDK package and contract when fallback is disabled", async () => {
  const { config } = await parsedConfig();
  config.runner.preferred = "sdk";
  config.runner.sdk = { package: "@vendor/agent-sdk", contract: "vendor-contract-v9" };
  config.runner.allow_fallback = false;

  const report = await validateStartup({
    config,
    fizzy: fakeFizzy(),
    runner: fakeRunner()
  });

  assert.equal(report.ok, false);
  assert.ok(errorCodes(report).includes("INVALID_RUNNER"));
});

test("validateStartup falls back from arbitrary SDK package and contract when fallback is allowed", async () => {
  const { config } = await parsedConfig();
  config.runner.preferred = "sdk";
  config.runner.sdk = { package: "@openai/codex-sdk", contract: "codex-sdk-js-v1" };
  config.runner.allow_fallback = true;
  config.runner.fallback = "cli_app_server";
  const calls = [];

  const report = await validateStartup({
    config,
    fizzy: fakeFizzy(),
    runner: {
      async detect(runnerConfig) {
        calls.push(["detect", runnerConfig.preferred]);
        return { kind: "cli_app_server", available: true };
      },
      async validate(runnerConfig) {
        calls.push(["validate", runnerConfig.preferred]);
        return { ok: true, kind: "cli_app_server" };
      },
      async health(runnerConfig) {
        calls.push(["health", runnerConfig.preferred]);
        return { status: "ready", kind: "cli_app_server" };
      }
    }
  });

  assert.equal(report.ok, true);
  assert.deepEqual(calls, [
    ["detect", "cli_app_server"],
    ["validate", "cli_app_server"],
    ["health", "cli_app_server"]
  ]);
});

test("validateStartup calls runner detect, validate, and health in order and reports detect failures distinctly", async () => {
  const { config } = await parsedConfig();
  const calls = [];

  const report = await validateStartup({
    config,
    fizzy: fakeFizzy(),
    runner: {
      async detect(runnerConfig) {
        calls.push(["detect", runnerConfig.preferred]);
        return { kind: "cli_app_server", available: true };
      },
      async validate(runnerConfig) {
        calls.push(["validate", runnerConfig.preferred]);
        return { ok: true };
      },
      async health(runnerConfig) {
        calls.push(["health", runnerConfig.preferred]);
        return { status: "ready" };
      }
    }
  });

  assert.equal(report.ok, true);
  assert.deepEqual(calls, [
    ["detect", "cli_app_server"],
    ["validate", "cli_app_server"],
    ["health", "cli_app_server"]
  ]);

  const failed = await validateStartup({
    config,
    fizzy: fakeFizzy(),
    runner: {
      async detect() {
        return { kind: "cli_app_server", available: false, reason: "missing executable" };
      },
      async validate() {
        throw new Error("validate should not run after failed detect");
      },
      async health() {
        throw new Error("health should not run after failed detect");
      }
    }
  });

  assert.equal(failed.ok, false);
  assert.ok(errorCodes(failed).includes("RUNNER_DETECT_FAILED"));

  const thrown = await validateStartup({
    config,
    fizzy: fakeFizzy(),
    runner: {
      async detect() {
        throw new Error("spawn failed");
      }
    }
  });

  assert.equal(thrown.ok, false);
  assert.ok(errorCodes(thrown).includes("RUNNER_DETECT_FAILED"));
});

test("discoverGoldenTicketRoutes parses aliases and produces stable IDs and fingerprints", () => {
  const routesA = discoverGoldenTicketRoutes([board()]);
  const routesB = discoverGoldenTicketRoutes([board()]);

  assert.equal(routesA.length, 1);
  assert.equal(routesA[0].id, "board:board_1:column:col_ready:golden:golden_ready");
  assert.equal(routesA[0].backend, "codex");
  assert.equal(routesA[0].workspace, "app");
  assert.equal(routesA[0].completion.policy, "move_to_column");
  assert.equal(routesA[0].completion.target_column_id, "col_done");
  assert.equal(routesA[0].fingerprint, routesB[0].fingerprint);
  assert.match(routesA[0].fingerprint, /^sha256:[a-f0-9]{64}$/);
});

test("discoverGoldenTicketRoutes rejects tag-only instruction cards and board-level tickets", () => {
  assert.throws(
    () => discoverGoldenTicketRoutes([board({
      cards: [{ id: "tag_only", golden: false, column_id: "col_ready", tags: ["agent-instructions", "move-to-done"] }]
    })]),
    (error) => error.code === "TAG_ONLY_INSTRUCTION_CARD"
  );

  assert.throws(
    () => discoverGoldenTicketRoutes([board({
      cards: [{ id: "board_level", golden: true, tags: ["agent-instructions", "agent-board", "move-to-done"] }]
    })]),
    (error) => error.code === "BOARD_LEVEL_GOLDEN_TICKET"
  );
});

test("discoverGoldenTicketRoutes rejects duplicate golden tickets and missing or conflicting completion policies", () => {
  assert.throws(
    () => discoverGoldenTicketRoutes([board({
      cards: [
        { id: "golden_1", golden: true, column_id: "col_ready", tags: ["agent-instructions", "move-to-done"] },
        { id: "golden_2", golden: true, column_id: "col_ready", tags: ["agent-instructions", "close-on-complete"] }
      ]
    })]),
    (error) => error.code === "DUPLICATE_GOLDEN_TICKETS"
  );

  assert.throws(
    () => discoverGoldenTicketRoutes([board({
      cards: [{ id: "golden_1", golden: true, column_id: "col_ready", tags: ["agent-instructions", "backend-codex"] }]
    })]),
    (error) => error.code === "MISSING_COMPLETION_POLICY"
  );

  assert.throws(
    () => discoverGoldenTicketRoutes([board({
      cards: [{ id: "golden_1", golden: true, column_id: "col_ready", tags: ["agent-instructions", "move-to-done", "close-on-complete"] }]
    })]),
    (error) => error.code === "CONFLICTING_COMPLETION_TAGS"
  );

  assert.throws(
    () => discoverGoldenTicketRoutes([board({
      cards: [{ id: "golden_1", golden: true, column_id: "col_ready", tags: ["agent-instructions", "move-to-done", "move-to-review"] }]
    })]),
    (error) => error.code === "CONFLICTING_COMPLETION_TAGS"
  );
});

test("discoverGoldenTicketRoutes rejects unknown managed tags, duplicate completion column slugs, same-column moves, and cycles", () => {
  assert.throws(
    () => discoverGoldenTicketRoutes([board({
      cards: [{ id: "golden_1", golden: true, column_id: "col_ready", tags: ["agent-instructions", "backend-shell", "move-to-done"] }]
    })]),
    (error) => error.code === "INVALID_BACKEND_TAG"
  );

  assert.throws(
    () => discoverGoldenTicketRoutes([board({
      columns: [
        { id: "col_ready", name: "Ready" },
        { id: "col_done_a", name: "Needs Review" },
        { id: "col_done_b", name: "Needs-Review" }
      ],
      cards: [{ id: "golden_1", golden: true, column_id: "col_ready", tags: ["agent-instructions", "move-to-needs-review"] }]
    })]),
    (error) => error.code === "DUPLICATE_COMPLETION_COLUMN_SLUG"
  );

  assert.throws(
    () => discoverGoldenTicketRoutes([board({
      columns: [{ id: "col_ready", name: "Ready" }],
      cards: [{ id: "golden_1", golden: true, column_id: "col_ready", tags: ["agent-instructions", "move-to-ready"] }]
    })]),
    (error) => error.code === "COMPLETION_SAME_COLUMN"
  );

  assert.throws(
    () => discoverGoldenTicketRoutes([board({
      columns: [{ id: "col_a", name: "A" }, { id: "col_b", name: "B" }],
      cards: [
        { id: "golden_a", golden: true, column_id: "col_a", tags: ["agent-instructions", "move-to-b"] },
        { id: "golden_b", golden: true, column_id: "col_b", tags: ["agent-instructions", "move-to-a"] }
      ]
    })]),
    (error) => error.code === "COMPLETION_CYCLE"
  );
});

test("discoverGoldenTicketRoutes scopes completion graph validation to each board", () => {
  const routes = discoverGoldenTicketRoutes([
    board({
      id: "board_1",
      columns: [{ id: "col_a", name: "A" }, { id: "col_b", name: "B" }],
      cards: [{ id: "golden_a", golden: true, column_id: "col_a", tags: ["agent-instructions", "move-to-b"] }]
    }),
    board({
      id: "board_2",
      columns: [{ id: "col_a", name: "A" }, { id: "col_b", name: "B" }],
      cards: [{ id: "golden_b", golden: true, column_id: "col_b", tags: ["agent-instructions", "move-to-a"] }]
    })
  ]);

  assert.equal(routes.length, 2);
  assert.equal(routes[0].board_id, "board_1");
  assert.equal(routes[1].board_id, "board_2");
});

test("validateStartup returns structured errors for unsafe startup state", async () => {
  const { config } = await parsedConfig();
  const unsafeBoard = board({
    cards: [{ id: "golden_1", golden: true, column_id: "col_ready", tags: ["agent-instructions"] }]
  });

  const report = await validateStartup({
    config,
    fizzy: fakeFizzy({ boards: [unsafeBoard] }),
    runner: fakeRunner({ status: "unavailable", reason: "missing codex" })
  });

  assert.equal(report.ok, false);
  assert.deepEqual(errorCodes(report), ["MISSING_COMPLETION_POLICY", "RUNNER_UNAVAILABLE"]);
  assert.deepEqual(report.warnings.map((warning) => warning.code), ["ENTROPY_UNKNOWN"]);
});

test("validateStartup detects missing secrets, invalid Fizzy access, invalid bot user, managed webhook issues, bad server port, bad claim mode, and unsafe cleanup", async () => {
  const { config } = await parsedConfig();
  config.fizzy.token = "";
  config.fizzy.bot_user_id = "missing_bot";
  config.claims.assign_on_claim = true;
  config.webhook.manage = true;
  config.webhook.callback_url = "http://127.0.0.1:4567/webhook";
  config.server.port = 70000;
  config.claims.mode = "tag_only";
  config.safety.cleanup.policy = "remove_clean_only";
  config.safety.cleanup.require_proof_before_cleanup = false;

  const report = await validateStartup({
    config,
    fizzy: fakeFizzy({ identityError: true, users: [{ id: "bot_1" }] }),
    runner: fakeRunner()
  });

  assert.equal(report.ok, false);
  assert.deepEqual(errorCodes(report), [
    "CONFIG_MISSING_SECRET",
    "INVALID_SERVER_PORT",
    "INVALID_CLAIM_MODE",
    "UNSAFE_CLEANUP_POLICY",
    "FIZZY_IDENTITY_INVALID",
    "INVALID_BOT_USER",
    "MANAGED_WEBHOOK_MISCONFIGURED"
  ]);
});

test("validateStartup reports missing WORKFLOW.md when fallback is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-no-workflow-"));
  const source = minimalConfig();
  const config = parseConfig(source, {
    configPath: join(dir, "config.json"),
    env: { FIZZY_API_TOKEN: "token" }
  });

  const report = await validateStartup({
    config,
    fizzy: fakeFizzy(),
    runner: fakeRunner()
  });

  assert.equal(report.ok, false);
  assert.ok(errorCodes(report).includes("MISSING_WORKFLOW"));
});

test("completion-failure markers are structured and malformed marker parsing is rejected", () => {
  const marker = createCompletionFailureMarker({
    run: { id: "run_1" },
    route: { id: "board:board_1:column:col_ready:golden:golden_1", fingerprint: "sha256:abc" },
    instance: { id: "instance_1" },
    workspace: { key: "workspace_1" },
    card: { id: "card_1", digest: "sha256:def" },
    failure_reason: "move target disappeared",
    result_comment_id: "comment_1",
    proof: { file: "proof.md", digest: "sha256:proof" }
  });
  const parsed = parseCompletionFailureMarker(marker.body);

  assert.match(marker.tag, /^agent-completion-failed-[a-f0-9]{12}$/);
  assert.match(marker.body, /<!-- fizzy-symphony-marker -->/);
  assert.match(marker.body, /fizzy-symphony:completion-failed:v1/);
  assert.match(marker.body, /```json/);
  assert.equal(parsed.marker, "fizzy-symphony:completion-failed:v1");
  assert.equal(parsed.kind, "completion_failed");
  assert.equal(parsed.run_id, "run_1");
  assert.equal(parsed.route_id, "board:board_1:column:col_ready:golden:golden_1");
  assert.equal(parsed.instance_id, "instance_1");
  assert.equal(parsed.workspace_key, "workspace_1");
  assert.equal(parsed.failure_reason, "move target disappeared");
  assert.equal(parsed.result_comment_id, "comment_1");
  assert.equal(parsed.proof_file, "proof.md");
  assert.equal(parsed.proof_digest, "sha256:proof");
  assert.equal(parsed.card_digest, "sha256:def");

  const wrapped = `operator note\n\n${marker.body}\n\nmore text`;
  assert.deepEqual(parseCompletionFailureMarker(wrapped), parsed);

  assert.throws(
    () => parseCompletionFailureMarker("not-json"),
    (error) => error.code === "MALFORMED_COMPLETION_FAILURE_MARKER"
  );

  assert.throws(
    () => parseCompletionFailureMarker("<!-- fizzy-symphony-marker -->\nfizzy-symphony:completion-failed:v1\n\n```json\n{ nope\n```"),
    (error) => error.code === "MALFORMED_COMPLETION_FAILURE_MARKER"
  );
});
