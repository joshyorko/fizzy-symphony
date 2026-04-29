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

function fakeFizzy({ identityError = false, boards = [board()], users = [{ id: "bot_1" }], tags = [] } = {}) {
  return {
    async getIdentity() {
      if (identityError) throw new Error("invalid");
      return { accounts: [{ id: "acct", name: "Account" }], user: { id: "user_1" } };
    },
    async listUsers() {
      return users;
    },
    async listTags() {
      return tags;
    },
    async getBoard(boardId) {
      const found = boards.find((candidate) => candidate.id === boardId);
      if (!found) throw new Error(`missing board ${boardId}`);
      return found;
    },
    async getEntropy() {
      return { warnings: [{ code: "ENTROPY_UNKNOWN", message: "Entropy settings not visible" }] };
    }
  };
}

function fakeRunner(health = { status: "ready", kind: "cli_app_server" }) {
  return {
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
    route: { id: "route_1", fingerprint: "sha256:abc" },
    card: { id: "card_1" },
    reason: "move target disappeared"
  });
  const parsed = parseCompletionFailureMarker(marker.body);

  assert.equal(parsed.marker, "fizzy-symphony:completion-failed:v1");
  assert.equal(parsed.route_id, "route_1");
  assert.equal(parsed.reason, "move target disappeared");

  assert.throws(
    () => parseCompletionFailureMarker("not-json"),
    (error) => error.code === "MALFORMED_COMPLETION_FAILURE_MARKER"
  );
});
