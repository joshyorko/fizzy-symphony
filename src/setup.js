import { access, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { writeAnnotatedConfig } from "./config.js";
import { FizzySymphonyError, isFizzySymphonyError } from "./errors.js";
import { discoverGoldenTicketRoutes, isSupportedSdkRunner, managedTagsUsedByBoards, resolveManagedTags } from "./validation.js";

const DEFAULT_WEBHOOK_ACTIONS = [
  "card_assigned",
  "card_closed",
  "card_postponed",
  "card_auto_postponed",
  "card_board_changed",
  "card_published",
  "card_reopened",
  "card_sent_back_to_triage",
  "card_triaged",
  "card_unassigned",
  "comment_created"
];

export async function runSetup(options = {}) {
  const {
    configPath = ".fizzy-symphony/config.yml",
    fizzy,
    runner,
    env = process.env,
    apiUrl,
    workspaceRepo = ".",
    webhook = {},
    prompts
  } = options;

  const identity = await validateIdentity(fizzy);
  const account = await selectAccount(identity, options.account, prompts);

  const boards = await callFizzySetupStep(
    () => fizzy.listBoards(account),
    "FIZZY_BOARDS_UNAVAILABLE",
    "Unable to list Fizzy boards for setup.",
    { account }
  );
  const users = await callFizzySetupStep(
    () => fizzy.listUsers(account),
    "FIZZY_USERS_UNAVAILABLE",
    "Unable to list Fizzy users for setup.",
    { account }
  );
  let tags = await callFizzySetupStep(
    () => fizzy.listTags(account),
    "FIZZY_TAGS_UNAVAILABLE",
    "Unable to list Fizzy tags for setup.",
    { account }
  );
  const runnerReport = await detectRunner(runner);

  const setupMode = await selectSetupMode(options, prompts);
  const selectedBoards = [];
  let selectedBoardIds = [];
  let starter = { created: false };

  if (setupMode === "create_starter") {
    const starterBoard = await createStarterBoard({ fizzy, account, workspaceRepo, options });
    selectedBoards.push(starterBoard);
    selectedBoardIds = [starterBoard.id];
    starter = { created: true, board_id: starterBoard.id };
    tags = await callFizzySetupStep(
      () => fizzy.listTags(account),
      "FIZZY_TAGS_UNAVAILABLE",
      "Unable to list Fizzy tags after starter board creation.",
      { account }
    );
  } else {
    selectedBoardIds = await selectBoardIds(boards, options, prompts);
    for (const boardId of selectedBoardIds) {
      selectedBoards.push(await callFizzySetupStep(
        () => fizzy.getBoard(boardId, { account }),
        "FIZZY_BOARD_UNAVAILABLE",
        "Unable to read selected Fizzy board for setup.",
        { account, board_id: boardId }
      ));
    }
    if (setupMode === "adopt_starter") {
      starter = { created: false, board_id: selectedBoardIds[0] };
    }
  }

  const entropy = await fizzy.getEntropy?.(account, selectedBoardIds);
  const resolvedTags = resolveManagedTags(tags, {
    required: ["agent-instructions", ...managedTagsUsedByBoards(selectedBoards)]
  });

  validateBotUser(options.botUserId, users);
  await ensureWorkflow(workspaceRepo, { create: Boolean(options.createStarterWorkflow) });
  const routes = discoverGoldenTicketRoutes(selectedBoards, {
    defaults: { backend: "codex", model: "", workspace: "app", persona: "repo-agent" }
  });

  const managedWebhooks = {};
  const warnings = (entropy?.warnings ?? []).map((warning) => ({
    code: warning.code ?? "ENTROPY_WARNING",
    message: warning.message ?? "Fizzy entropy warning.",
    details: warning
  }));

  if (webhook.manage) {
    warnings.push(...validateWebhookSetup(webhook));
    for (const boardId of selectedBoardIds) {
      managedWebhooks[boardId] = await manageWebhookForBoard(fizzy, {
        account,
        board_id: boardId,
        callback_url: webhook.callback_url,
        secret: webhook.secret,
        subscribed_actions: webhookActions(webhook)
      });
    }
  }

  await writeAnnotatedConfig(configPath, {
    account,
    boards: selectedBoards.map((board) => ({
      id: board.id,
      label: board.name ?? board.label ?? board.id
    })),
    agentMaxConcurrent: starter.created || setupMode === "adopt_starter" ? 1 : 2,
    boardMaxConcurrent: starter.created || setupMode === "adopt_starter" ? 1 : 2,
    runnerPreferred: runnerReport.kind === "sdk" ? "sdk" : "cli_app_server",
    runnerFallback: "cli_app_server",
    sdkPackage: runnerReport.kind === "sdk" ? runnerReport.package : "",
    sdkContract: runnerReport.kind === "sdk" ? runnerReport.contract : "",
    apiUrl,
    botUserId: options.botUserId ?? "",
    workspaceRepo,
    webhook,
    managedWebhookIdsByBoard: Object.fromEntries(
      Object.entries(managedWebhooks).map(([boardId, managedWebhook]) => [boardId, managedWebhook.id])
    )
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
    warnings,
    managedWebhooks,
    starter,
    env_used: {
      fizzy_token: Boolean(env.FIZZY_API_TOKEN)
    }
  };
}

async function validateIdentity(fizzy) {
  try {
    return await fizzy.getIdentity();
  } catch (error) {
    throw new FizzySymphonyError(
      "FIZZY_IDENTITY_INVALID",
      "Unable to validate Fizzy identity.",
      fizzyAccessFailureDetails(error)
    );
  }
}

async function callFizzySetupStep(action, code, message, details = {}) {
  try {
    return await action();
  } catch (error) {
    if (isFizzySymphonyError(error)) throw error;
    throw new FizzySymphonyError(code, message, {
      ...details,
      ...fizzyAccessFailureDetails(error)
    });
  }
}

async function selectAccount(identity, requestedAccount, prompts) {
  const accounts = identity.accounts ?? [];
  if (requestedAccount) {
    const requested = normalizeAccountSlug(requestedAccount);
    const match = accounts.find((account) => {
      const slug = normalizeAccountSlug(account.slug ?? account.path);
      return account.id === requestedAccount ||
        account.name === requestedAccount ||
        slug === requested ||
        accountConfigValue(account) === requested;
    });
    if (!match) {
      throw new FizzySymphonyError("FIZZY_ACCOUNT_UNAVAILABLE", "Requested Fizzy account is not available.", {
        account: requestedAccount
      });
    }
    return accountConfigValue(match);
  }

  const first = accounts[0];
  if (!first) {
    throw new FizzySymphonyError("FIZZY_ACCOUNT_UNAVAILABLE", "Fizzy identity did not include any accounts.");
  }
  const prompted = await prompts?.selectAccount?.(accounts);
  if (prompted && typeof prompted === "object") return accountConfigValue(prompted);
  if (prompted) return normalizeAccountSlug(prompted);
  return accountConfigValue(first);
}

function accountConfigValue(account) {
  const slug = normalizeAccountSlug(account?.slug ?? account?.path);
  return slug || account?.id || account?.name;
}

function normalizeAccountSlug(value) {
  return String(value ?? "").trim().replace(/^\/+|\/+$/gu, "");
}

async function selectSetupMode(options, prompts) {
  if (options.setupMode) return options.setupMode;
  return (await prompts?.selectSetupMode?.(["existing", "create_starter", "adopt_starter"])) ?? "existing";
}

async function selectBoardIds(boards, options, prompts) {
  if (options.selectedBoardIds) return options.selectedBoardIds;
  const prompted = await prompts?.selectBoards?.(boards);
  if (prompted?.length) {
    return prompted.map((board) => typeof board === "object" ? board.id : board);
  }
  const selected = boards.slice(0, 1).map((board) => board.id);
  if (selected.length === 0) {
    throw new FizzySymphonyError("FIZZY_BOARD_UNAVAILABLE", "Setup requires at least one selected Fizzy board.");
  }
  return selected;
}

async function createStarterBoard({ fizzy, account, workspaceRepo, options }) {
  const name = options.starterBoardName ?? `Agent Playground: ${basename(resolve(workspaceRepo))}`;
  const plan = {
    account,
    name,
    columns: ["Ready for Agents", "Done"],
    golden_ticket: {
      title: "Repo Agent",
      description: starterGoldenDescription(),
      column: "Ready for Agents",
      golden: true,
      tags: ["agent-instructions", "codex", "move-to-done"]
    },
    smoke_test: Boolean(options.createSmokeTestCard)
  };

  if (fizzy.createStarterBoard) {
    const created = await fizzy.createStarterBoard(plan);
    const boardId = created.board?.id ?? created.id ?? created.board_id;
    if (!boardId) {
      throw new FizzySymphonyError("STARTER_BOARD_UNAVAILABLE", "Starter board creation did not return a board ID.");
    }
    return await fizzy.getBoard(boardId, { account });
  }

  if (!fizzy.createBoard || !fizzy.createColumn || !fizzy.createCard) {
    throw new FizzySymphonyError("STARTER_BOARD_UNAVAILABLE", "Fizzy client cannot create starter board resources.");
  }

  const board = await fizzy.createBoard({ account, name });
  const ready = await fizzy.createColumn({ account, board_id: board.id, name: "Ready for Agents" });
  await fizzy.createColumn({ account, board_id: board.id, name: "Done" });
  const golden = await fizzy.createCard({
    account,
    board_id: board.id,
    column_id: ready.id,
    title: "Repo Agent",
    description: plan.golden_ticket.description,
    tags: ["agent-instructions", "codex", "move-to-done"],
    golden: true
  });

  if (fizzy.markGolden) {
    await fizzy.markGolden({
      account,
      board_id: board.id,
      card_id: golden.id,
      card_number: golden.number ?? golden.card_number
    });
  }

  return await fizzy.getBoard(board.id, { account });
}

function validateBotUser(botUserId, users) {
  if (!botUserId) return;
  if (!users.some((user) => user.id === botUserId)) {
    throw new FizzySymphonyError("INVALID_BOT_USER", "Configured bot user is not present in account users.", {
      bot_user_id: botUserId
    });
  }
}

async function ensureWorkflow(workspaceRepo, options = {}) {
  try {
    await access(join(workspaceRepo, "WORKFLOW.md"));
  } catch {
    if (options.create) {
      await writeFile(join(workspaceRepo, "WORKFLOW.md"), starterWorkflow(), { flag: "wx" });
      return;
    }
    throw new FizzySymphonyError("MISSING_WORKFLOW", "Setup requires WORKFLOW.md in the selected workspace repository.", {
      repo: workspaceRepo
    });
  }
}

function starterWorkflow() {
  return [
    "# fizzy-symphony starter workflow",
    "",
    "You are working from a Fizzy card through fizzy-symphony.",
    "",
    "Rules:",
    "- Keep the change focused on the card request.",
    "- Prefer the repo's existing patterns.",
    "- Run `npm test` before reporting success.",
    "- Leave a short result summary on the card.",
    "- If the request is unsafe or unclear, stop and explain the blocker.",
    ""
  ].join("\n");
}

function starterGoldenDescription() {
  return [
    "Use Codex to complete normal cards moved into this column.",
    "",
    "Read the card, follow the repository WORKFLOW.md, make the smallest useful change, run the checks, and report the result back on the card."
  ].join("\n");
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
  if (report.kind === "sdk" && !isSupportedSdkRunner(report)) {
    return {
      kind: "cli_app_server",
      available: true,
      fallback_from: "sdk",
      reason: "No SDK runner contract is selected for Task 1."
    };
  }
  return report;
}

function validateWebhookSetup(webhook) {
  const warnings = [];

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
    warnings.push({
      code: "WEBHOOK_SECRET_NOT_CONFIGURED",
      message: "Managed webhook setup will continue without signature verification because no signing secret was configured.",
      details: { manage: Boolean(webhook.manage), callback_url: webhook.callback_url }
    });
  }

  return warnings;
}

async function manageWebhookForBoard(fizzy, request) {
  if (fizzy.ensureWebhook) {
    return fizzy.ensureWebhook(request);
  }

  if (!fizzy.listWebhooks || !fizzy.createWebhook) {
    throw new FizzySymphonyError("MANAGED_WEBHOOK_UNAVAILABLE", "Fizzy client cannot manage webhooks.");
  }

  const existing = await fizzy.listWebhooks({ account: request.account, board_id: request.board_id });
  const match = (existing ?? []).find((webhook) => webhook.callback_url === request.callback_url);

  if (!match) {
    return fizzy.createWebhook(omitUndefined(request));
  }

  if (match.active === false || match.status === "inactive") {
    if (!fizzy.reactivateWebhook) {
      throw new FizzySymphonyError("MANAGED_WEBHOOK_UNAVAILABLE", "Fizzy client cannot reactivate inactive managed webhooks.");
    }
    return fizzy.reactivateWebhook({
      ...omitUndefined(request),
      webhook_id: match.id
    });
  }

  if (!sameActions(match.subscribed_actions, request.subscribed_actions)) {
    if (!fizzy.updateWebhook) {
      throw new FizzySymphonyError("MANAGED_WEBHOOK_UNAVAILABLE", "Fizzy client cannot update managed webhook subscriptions.");
    }
    return fizzy.updateWebhook({
      ...omitUndefined(request),
      webhook_id: match.id
    });
  }

  return match;
}

function webhookActions(webhook) {
  return webhook.subscribed_actions?.length ? webhook.subscribed_actions : DEFAULT_WEBHOOK_ACTIONS;
}

function sameActions(left = [], right = []) {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((action, index) => action === normalizedRight[index]);
}

function omitUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== ""));
}

function fizzyAccessFailureDetails(error) {
  const status = error.status ?? error.metadata?.status;
  const authenticationFailure = status === 401 || status === 403;
  return omitUndefined({
    cause: error.message,
    status,
    request_id: error.metadata?.request_id,
    remediation: authenticationFailure
      ? "Check FIZZY_API_TOKEN and confirm the token can access the selected Fizzy account, then rerun setup."
      : "Check FIZZY_API_URL, network access, and Fizzy API availability, then rerun setup."
  });
}
