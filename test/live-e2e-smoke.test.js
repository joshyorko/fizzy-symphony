import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createCliFizzyClient, createCliRunner } from "../src/client-factories.js";
import { cardColumnId, commentBody } from "../src/fizzy-normalize.js";
import { runSetup } from "../src/setup.js";
import { startDaemon } from "../src/daemon.js";

const execFileAsync = promisify(execFile);
const LIVE_CONFIRMATION = "real-fizzy-codex-worktree";
const LIVE_SCRIPT = "node --test test/live-e2e-smoke.test.js";
const REQUIRED_LIVE_ENV = [
  "FIZZY_SYMPHONY_LIVE_E2E",
  "FIZZY_SYMPHONY_LIVE_CONFIRM",
  "FIZZY_API_TOKEN"
];

test("live E2E smoke is opt-in and documents the command shape", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.deepEqual(REQUIRED_LIVE_ENV, [
    "FIZZY_SYMPHONY_LIVE_E2E",
    "FIZZY_SYMPHONY_LIVE_CONFIRM",
    "FIZZY_API_TOKEN"
  ]);
  assert.equal(LIVE_CONFIRMATION, "real-fizzy-codex-worktree");
  assert.equal(packageJson.scripts["test:live:e2e"], LIVE_SCRIPT);
  assert.equal(liveSkipReason({}), "set FIZZY_SYMPHONY_LIVE_E2E=1 to run the live Fizzy/Codex smoke");
  assert.equal(liveSkipReason({
    FIZZY_SYMPHONY_LIVE_E2E: "1",
    FIZZY_SYMPHONY_LIVE_CONFIRM: LIVE_CONFIRMATION,
    FIZZY_API_TOKEN: "token"
  }), false);
});

test("live Fizzy card to Codex worktree to completion smoke", { timeout: liveTimeoutMs(), skip: liveSkipReason(process.env) }, async () => {
  const root = await mkdtemp(join(tmpdir(), "fizzy-symphony-live-e2e-"));
  const repo = join(root, "repo");
  const configPath = join(root, ".fizzy-symphony", "config.yml");
  const env = liveEnv(process.env);
  let daemon;

  await initializeDisposableRepo(repo);

  const fizzy = createCliFizzyClient({ env });
  const runner = createCliRunner();
  const setupResult = await runSetup({
    configPath,
    fizzy,
    runner,
    env,
    apiUrl: env.FIZZY_API_URL,
    account: env.FIZZY_SYMPHONY_LIVE_ACCOUNT,
    setupMode: "create_starter",
    workspaceRepo: repo,
    starterBoardName: `fizzy-symphony live E2E ${Date.now()}`,
    createSmokeTestCard: true,
    workflowPolicy: "skip",
    maxAgents: 1
  });

  const configText = await readFile(configPath, "utf8");
  assert.doesNotMatch(configText, new RegExp(escapeRegExp(env.FIZZY_API_TOKEN), "u"));
  assert.match(configText, /token: \$FIZZY_API_TOKEN/u);

  const board = setupResult.boards[0];
  const smokeCard = findSmokeCard(board);
  assert.ok(smokeCard, "setup should create a normal smoke card on the disposable board");

  try {
    daemon = await startDaemon({
      configPath,
      env,
      schedulerOptions: { immediate: false },
      signalProcess: null
    });

    const tick = await withTimeout(
      daemon.scheduler.tickNow("live-e2e-smoke"),
      liveTimeoutMs(),
      "live E2E reconciliation tick timed out"
    );
    assert.equal(tick.dispatched, 1);
    assert.equal(tick.completed, 1);

    const snapshot = daemon.status.status();
    const completed = snapshot.runs.completed.find((run) => run.card_id === smokeCard.id) ?? snapshot.runs.completed[0];
    assert.ok(completed, "daemon status should record a completed run");
    assert.equal(completed.result_comment_id ? true : false, true);
    assert.equal(completed.completion_marker ? true : false, true);

    const freshCard = await daemon.fizzy.getCard(cardLookup(smokeCard, completed, setupResult.account));
    const comments = await daemon.fizzy.listComments(cardLookup(freshCard, completed, setupResult.account));
    const route = snapshot.routes.find((candidate) => candidate.board_id === board.id) ?? snapshot.routes[0];

    assert.ok(comments.some((comment) => commentBody(comment).includes("fizzy-symphony:completion:v1")));
    assert.ok(hasCompletedTag(freshCard, route), "completed card should have an agent-completed tag");
    assert.equal(cardColumnId(freshCard), route.completion.target_column_id);
  } finally {
    await daemon?.stop?.("live-e2e-smoke");
  }
});

function liveSkipReason(env) {
  if (env.FIZZY_SYMPHONY_LIVE_E2E !== "1") {
    return "set FIZZY_SYMPHONY_LIVE_E2E=1 to run the live Fizzy/Codex smoke";
  }
  if (env.FIZZY_SYMPHONY_LIVE_CONFIRM !== LIVE_CONFIRMATION) {
    return `set FIZZY_SYMPHONY_LIVE_CONFIRM=${LIVE_CONFIRMATION} to acknowledge live board/card writes`;
  }
  if (!env.FIZZY_API_TOKEN) {
    return "set FIZZY_API_TOKEN for the disposable live Fizzy board";
  }
  return false;
}

function liveEnv(env) {
  return {
    ...env,
    FIZZY_API_URL: env.FIZZY_API_URL || "https://app.fizzy.do",
    FIZZY_SYMPHONY_PROMPTS: "plain",
    CI: env.CI || "1"
  };
}

function liveTimeoutMs() {
  return Number(process.env.FIZZY_SYMPHONY_LIVE_TIMEOUT_MS ?? 600000);
}

async function initializeDisposableRepo(repo) {
  await execFileAsync("git", ["init", repo]);
  await writeFile(join(repo, "README.md"), "# fizzy-symphony live smoke\n", "utf8");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "Initial live smoke fixture"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fizzy-symphony smoke",
      GIT_AUTHOR_EMAIL: "fizzy-symphony-smoke@example.invalid",
      GIT_COMMITTER_NAME: "fizzy-symphony smoke",
      GIT_COMMITTER_EMAIL: "fizzy-symphony-smoke@example.invalid"
    }
  });
}

function findSmokeCard(board = {}) {
  return (board.cards ?? []).find((card) => !card.golden && card.title === "Smoke test fizzy-symphony");
}

function cardLookup(card = {}, completed = {}, account) {
  return {
    ...card,
    account,
    card_id: card.id ?? completed.card_id,
    card_number: card.number ?? card.card_number ?? completed.card_number,
    number: card.number ?? card.card_number ?? completed.card_number
  };
}

function hasCompletedTag(card = {}, route = {}) {
  const routeSuffix = route.id ? shortRouteId(route.id) : "";
  return (card.tags ?? []).some((tag) => {
    const value = typeof tag === "string" ? tag : tag.title ?? tag.name ?? tag.slug ?? "";
    return value === `agent-completed-${routeSuffix}` || value.startsWith("agent-completed-");
  });
}

function shortRouteId(routeId) {
  let hash = 0;
  for (const char of routeId) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
