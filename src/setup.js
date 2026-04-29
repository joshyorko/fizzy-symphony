import { access } from "node:fs/promises";
import { join } from "node:path";

import { writeAnnotatedConfig } from "./config.js";
import { FizzySymphonyError } from "./errors.js";
import { discoverGoldenTicketRoutes, managedTagsUsedByBoards, resolveManagedTags } from "./validation.js";

export async function runSetup(options = {}) {
  const {
    configPath = ".fizzy-symphony/config.yml",
    fizzy,
    runner,
    env = process.env,
    workspaceRepo = ".",
    webhook = {}
  } = options;

  const identity = await validateIdentity(fizzy);
  const account = selectAccount(identity, options.account);

  const boards = await fizzy.listBoards(account);
  const users = await fizzy.listUsers(account);
  const tags = await fizzy.listTags(account);
  const selectedBoardIds = options.selectedBoardIds ?? boards.slice(0, 1).map((board) => board.id);
  const entropy = await fizzy.getEntropy?.(account, selectedBoardIds);
  const runnerReport = await detectRunner(runner);

  const selectedBoards = [];
  for (const boardId of selectedBoardIds) {
    selectedBoards.push(await fizzy.getBoard(boardId));
  }
  const resolvedTags = resolveManagedTags(tags, {
    required: ["agent-instructions", ...managedTagsUsedByBoards(selectedBoards)]
  });

  validateBotUser(options.botUserId, users);
  await validateWorkflow(workspaceRepo);
  const routes = discoverGoldenTicketRoutes(selectedBoards, {
    defaults: { backend: "codex", model: "", workspace: "app", persona: "repo-agent" }
  });

  const managedWebhooks = {};
  if (webhook.manage) {
    validateWebhookSetup(webhook);
    for (const boardId of selectedBoardIds) {
      managedWebhooks[boardId] = await fizzy.ensureWebhook({
        account,
        board_id: boardId,
        callback_url: webhook.callback_url,
        secret: webhook.secret,
        subscribed_actions: webhook.subscribed_actions
      });
    }
  }

  await writeAnnotatedConfig(configPath, {
    account,
    board: {
      id: selectedBoards[0]?.id ?? "board_123",
      label: selectedBoards[0]?.name ?? selectedBoards[0]?.label ?? "Agent Playground"
    },
    runnerPreferred: runnerReport.kind === "sdk" ? "sdk" : "cli_app_server",
    runnerFallback: "cli_app_server",
    sdkPackage: runnerReport.kind === "sdk" ? runnerReport.package : "",
    sdkContract: runnerReport.kind === "sdk" ? runnerReport.contract : "",
    botUserId: options.botUserId ?? "",
    webhook
  });

  return {
    ok: true,
    path: configPath,
    account,
    boards: selectedBoards,
    users,
    tags,
    resolvedTags,
    routes,
    runner: runnerReport,
    warnings: (entropy?.warnings ?? []).map((warning) => ({
      code: warning.code ?? "ENTROPY_WARNING",
      message: warning.message ?? "Fizzy entropy warning.",
      details: warning
    })),
    managedWebhooks,
    env_used: {
      fizzy_token: Boolean(env.FIZZY_API_TOKEN)
    }
  };
}

async function validateIdentity(fizzy) {
  try {
    return await fizzy.getIdentity();
  } catch (error) {
    throw new FizzySymphonyError("FIZZY_IDENTITY_INVALID", "Unable to validate Fizzy identity.", {
      cause: error.message
    });
  }
}

function selectAccount(identity, requestedAccount) {
  const accounts = identity.accounts ?? [];
  if (requestedAccount) {
    const match = accounts.find((account) => account.id === requestedAccount || account.name === requestedAccount);
    if (!match) {
      throw new FizzySymphonyError("FIZZY_ACCOUNT_UNAVAILABLE", "Requested Fizzy account is not available.", {
        account: requestedAccount
      });
    }
    return match.id ?? match.name;
  }

  const first = accounts[0];
  if (!first) {
    throw new FizzySymphonyError("FIZZY_ACCOUNT_UNAVAILABLE", "Fizzy identity did not include any accounts.");
  }
  return first.id ?? first.name;
}

function validateBotUser(botUserId, users) {
  if (!botUserId) return;
  if (!users.some((user) => user.id === botUserId)) {
    throw new FizzySymphonyError("INVALID_BOT_USER", "Configured bot user is not present in account users.", {
      bot_user_id: botUserId
    });
  }
}

async function validateWorkflow(workspaceRepo) {
  try {
    await access(join(workspaceRepo, "WORKFLOW.md"));
  } catch {
    throw new FizzySymphonyError("MISSING_WORKFLOW", "Setup requires WORKFLOW.md in the selected workspace repository.", {
      repo: workspaceRepo
    });
  }
}

async function detectRunner(runner) {
  const report = runner?.detect ? await runner.detect() : { kind: "cli_app_server", available: false };
  if (report.available === false) {
    throw new FizzySymphonyError("RUNNER_UNAVAILABLE", "No usable Codex runner was detected.", report);
  }
  if (report.kind === "sdk" && (!report.package || !report.contract)) {
    return {
      kind: "cli_app_server",
      available: true,
      fallback_from: "sdk",
      reason: "SDK runner requires an exact package and contract."
    };
  }
  return report;
}

function validateWebhookSetup(webhook) {
  try {
    const url = new URL(webhook.callback_url);
    if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      throw new Error("callback URL is not public HTTPS");
    }
  } catch (error) {
    throw new FizzySymphonyError("MANAGED_WEBHOOK_MISCONFIGURED", "Managed webhooks require a public HTTPS callback.", {
      callback_url: webhook.callback_url,
      cause: error.message
    });
  }

  if (!webhook.secret) {
    throw new FizzySymphonyError("MANAGED_WEBHOOK_MISCONFIGURED", "Managed webhooks require a signing secret.");
  }
}
