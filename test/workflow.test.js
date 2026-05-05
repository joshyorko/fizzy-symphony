import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  WorkflowCache,
  createCachedWorkflowLoader,
  createWorkflowCache,
  loadWorkflow,
  parseWorkflow,
  renderPrompt
} from "../src/workflow.js";
import { createStatusStore } from "../src/status.js";

test("parseWorkflow parses optional front matter and markdown body", () => {
  const workflow = parseWorkflow(`---
name: Repo Agent
validation:
  commands:
    - npm test
hooks:
  after_create: scripts/bootstrap
enabled: true
max_turns: 3
tags:
  - backend
  - fizzy
---
# Policy

Use {{card.title}} for context.
`);

  assert.deepEqual(workflow.frontMatter, {
    name: "Repo Agent",
    validation: { commands: ["npm test"] },
    hooks: { after_create: "scripts/bootstrap" },
    enabled: true,
    max_turns: 3,
    tags: ["backend", "fizzy"]
  });
  assert.equal(workflow.body, "# Policy\n\nUse {{card.title}} for context.");
});

test("parseWorkflow treats markdown without front matter as the full body", () => {
  const workflow = parseWorkflow("# Policy\n\nNo metadata here.\n");

  assert.deepEqual(workflow.frontMatter, {});
  assert.equal(workflow.body, "# Policy\n\nNo metadata here.");
});

test("parseWorkflow throws structured errors for invalid front matter", () => {
  assert.throws(
    () => parseWorkflow("---\n- not a map\n---\nBody\n"),
    (error) => error.code === "WORKFLOW_FRONT_MATTER_INVALID" && error.details.reason === "not_map"
  );

  assert.throws(
    () => parseWorkflow("---\nname\n---\nBody\n"),
    (error) => error.code === "WORKFLOW_FRONT_MATTER_INVALID" && error.details.line === 1
  );
});

test("loadWorkflow uses deterministic discovery and fails missing files unless fallback is explicit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-workflow-load-"));
  const sourceRepo = join(dir, "source");
  const workspacePath = join(dir, "workspace");
  const fallbackPath = join(dir, "fallback.md");

  await writeFile(fallbackPath, "# Fallback\n", "utf8");

  await assert.rejects(
    () => loadWorkflow({
      workspace: { sourceRepo, path: workspacePath, config: { workflow_path: "WORKFLOW.md" } },
      config: { workflow: { fallback_enabled: false, fallback_path: fallbackPath } }
    }),
    (error) => error.code === "WORKFLOW_MISSING"
  );

  const workflow = await loadWorkflow({
    workspace: { sourceRepo, path: workspacePath, config: { workflow_path: "WORKFLOW.md" } },
    config: { workflow: { fallback_enabled: true, fallback_path: fallbackPath } }
  });

  assert.equal(workflow.path, fallbackPath);
  assert.equal(workflow.source, "fallback");
  assert.equal(workflow.body, "# Fallback");
});

test("loadWorkflow prefers explicit workflow_path, then source repo, then prepared workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-workflow-order-"));
  const sourceRepo = join(dir, "source");
  const workspacePath = join(dir, "workspace");
  const explicitPath = join(dir, "custom", "AGENT.md");

  await mkdir(join(dir, "custom"), { recursive: true });
  await mkdir(sourceRepo, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(explicitPath, "# Explicit\n", "utf8");
  await writeFile(join(sourceRepo, "WORKFLOW.md"), "# Source\n", "utf8");
  await writeFile(join(workspacePath, "WORKFLOW.md"), "# Workspace\n", "utf8");

  const explicit = await loadWorkflow({
    workspace: { sourceRepo, path: workspacePath, config: { workflow_path: explicitPath } },
    config: { workflow: { fallback_enabled: false } }
  });
  assert.equal(explicit.path, explicitPath);
  assert.equal(explicit.source, "explicit");
  assert.equal(explicit.body, "# Explicit");

  const source = await loadWorkflow({
    workspace: { sourceRepo, path: workspacePath, config: {} },
    config: { workflow: { fallback_enabled: false } }
  });
  assert.equal(source.path, join(sourceRepo, "WORKFLOW.md"));
  assert.equal(source.source, "source_repo");
});

test("renderPrompt includes route, card, workspace, attempt, and completion context", () => {
  const prompt = renderPrompt({
    workflow: parseWorkflow(`---
name: Repo Agent
completion:
  required_steps_block_completion: true
---
# Repo Policy

Ticket: {{card.title}}
Route: {{route.id}}
`),
    board: { id: "board_1", name: "Agents" },
    column: { id: "col_ready", name: "Ready" },
    route: {
      id: "board:board_1:column:col_ready:golden:golden_1",
      golden_card_id: "golden_1",
      backend: "codex",
      model: "gpt-5",
      workspace: "app",
      persona: "repo-agent",
      completion: { type: "move", target_column_id: "col_done", target_column_name: "Done" }
    },
    card: {
      id: "card_1",
      title: "Fix parser",
      description: "Implement WORKFLOW.md support.",
      steps: [
        { title: "Add tests", completed: true },
        { title: "Implement loader", completed: false }
      ],
      tags: ["backend", "priority-1"],
      assignees: [{ id: "user_1", name: "Josh" }],
      comments: [
        { author: "Josh", body: "Please keep it small." }
      ],
      url: "https://fizzy.example/cards/card_1"
    },
    attempt: 2,
    workspace: {
      id: "ws_card_1",
      path: "/tmp/ws",
      sourceRepo: "/repo",
      branch: "fizzy/card_1",
      metadataPath: "/tmp/meta/card_1.json"
    },
    workpad: {
      comment_id: "workpad_1",
      phase: "claimed",
      updated_at: "2026-04-29T12:00:00.000Z"
    },
    completion: {
      markers: {
        mode: "structured_comment_and_tag",
        success_tag_prefix: "agent-completed",
        failure_tag_prefix: "agent-completion-failed"
      }
    }
  });

  assert.match(prompt, /Fizzy result comment format/);
  assert.match(prompt, /Return the final response as HTML suitable for a Fizzy rich-text comment/);
  assert.match(prompt, /Workflow front matter:\n```json\n\{/);
  assert.match(prompt, /"name": "Repo Agent"/);
  assert.match(prompt, /"required_steps_block_completion": true/);
  assert.match(prompt, /Workflow prompt body/);
  assert.match(prompt, /# Repo Policy/);
  assert.match(prompt, /Ticket: Fix parser/);
  assert.match(prompt, /Board:\n- id: board_1\n- name: Agents/);
  assert.match(prompt, /Column:\n- id: col_ready\n- name: Ready/);
  assert.match(prompt, /Golden-ticket route:\n- id: board:board_1:column:col_ready:golden:golden_1/);
  assert.match(prompt, /Work card:\n- id: card_1\n- title: Fix parser/);
  assert.match(prompt, /Description:\nImplement WORKFLOW.md support\./);
  assert.match(prompt, /Steps:\n- \[x\] Add tests\n- \[ \] Implement loader/);
  assert.match(prompt, /Tags:\n- backend\n- priority-1/);
  assert.match(prompt, /Comments:\n- Josh: Please keep it small\./);
  assert.match(prompt, /URL: https:\/\/fizzy\.example\/cards\/card_1/);
  assert.match(prompt, /Attempt: 2/);
  assert.match(prompt, /Workspace:\n- id: ws_card_1\n- path: \/tmp\/ws/);
  assert.match(prompt, /Active workpad:\n```json\n\{/);
  assert.match(prompt, /"comment_id": "workpad_1"/);
  assert.match(prompt, /Completion policy:\n```json\n\{/);
});

test("renderPrompt includes live Fizzy rich-text card and comment bodies as plain text", () => {
  const prompt = renderPrompt({
    workflow: parseWorkflow("# Policy\n\nUse card context."),
    board: { id: "board_1" },
    column: { id: "col_ready" },
    route: { id: "route_1", fingerprint: "sha256:route", completion: { policy: "comment_once" } },
    card: {
      id: "card_1",
      title: "Normalize live text",
      body: { plain_text: "Use the visible body.", html: "<p>Use the visible body.</p>" },
      comments: [{ author: { name: "Josh" }, body: { plain_text: "Loop markers live here.", html: "<p>Loop markers live here.</p>" } }]
    },
    workspace: {},
    completion: {}
  });

  assert.match(prompt, /Description:\nUse the visible body\./u);
  assert.match(prompt, /Josh: Loop markers live here\./u);
  assert.doesNotMatch(prompt, /\[object Object\]/u);
});

test("renderPrompt rejects unknown template variables", () => {
  assert.throws(
    () => renderPrompt({
      workflow: parseWorkflow("Hello {{card.missing}}"),
      board: {},
      column: {},
      route: {},
      card: { title: "Known" },
      attempt: 1,
      workspace: {},
      completion: {}
    }),
    (error) => error.code === "WORKFLOW_TEMPLATE_UNKNOWN_VARIABLE" && error.details.variable === "card.missing"
  );
});

test("WorkflowCache keeps the last known good workflow after a failed reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fizzy-symphony-workflow-cache-"));
  const workflowPath = join(dir, "WORKFLOW.md");
  const loaderOptions = {
    workspace: { sourceRepo: dir, path: dir, config: { workflow_path: workflowPath } },
    config: { workflow: { fallback_enabled: false } }
  };

  await writeFile(workflowPath, "# First\n", "utf8");
  const cache = createWorkflowCache(loaderOptions);

  const first = await cache.reload();
  assert.equal(first.workflow.body, "# First");
  assert.equal(cache.workflow.body, "# First");
  assert.equal(cache.reloadError, null);

  await writeFile(workflowPath, "---\nname\n---\nBroken\n", "utf8");
  const second = await cache.reload();

  assert.equal(second.ok, false);
  assert.equal(second.workflow.body, "# First");
  assert.equal(cache.workflow.body, "# First");
  assert.equal(cache.reloadError.code, "WORKFLOW_FRONT_MATTER_INVALID");
  assert.ok(cache instanceof WorkflowCache);
});

test("cached workflow loader records reload failures while returning last known good workflow", async () => {
  const status = createStatusStore({
    instance: { id: "instance-a" },
    startedAt: "2026-04-29T12:00:00.000Z",
    config: { workflow: { fallback_enabled: false } }
  });
  const route = { id: "route_1", fingerprint: "sha256:route" };
  const card = { id: "card_1", number: 1, board_id: "board_1" };
  const workspace = { key: "workspace_app", sourceRepo: "/repo/app", path: "/tmp/workspace-app" };
  const calls = [];
  const loader = createCachedWorkflowLoader({
    status,
    loader: async () => {
      calls.push("load");
      if (calls.length === 1) return { body: "# First", frontMatter: {}, path: "/repo/app/WORKFLOW.md" };
      const error = new Error("front matter broke");
      error.code = "WORKFLOW_FRONT_MATTER_INVALID";
      error.details = { path: "/repo/app/WORKFLOW.md" };
      throw error;
    }
  });

  const first = await loader.load({ config: {}, card, route, workspace });
  const second = await loader.load({ config: {}, card, route, workspace });

  assert.equal(first.body, "# First");
  assert.equal(second.body, "# First");
  assert.deepEqual(calls, ["load", "load"]);

  const snapshot = status.status();
  assert.equal(snapshot.workflow_cache.recent_reload_errors.length, 1);
  assert.equal(snapshot.workflow_cache.recent_reload_errors[0].code, "WORKFLOW_FRONT_MATTER_INVALID");
  assert.equal(snapshot.workflow_cache.recent_reload_errors[0].cache_hit, true);
  assert.equal(snapshot.workflow_cache.recent_reload_errors[0].route_id, "route_1");
  assert.equal(snapshot.workflow_cache.recent_reload_errors[0].card_id, "card_1");
  assert.equal(snapshot.workflow_cache.entries[0].status, "cached_after_error");
  assert.equal(snapshot.recent_failures.at(-1).failure_kind, "workflow_reload");
});

test("cached workflow loader reports invalid workflow with no last known good and rethrows", async () => {
  const status = createStatusStore({
    instance: { id: "instance-a" },
    startedAt: "2026-04-29T12:00:00.000Z",
    config: { workflow: { fallback_enabled: false } }
  });
  const error = new Error("missing closing delimiter");
  error.code = "WORKFLOW_FRONT_MATTER_INVALID";
  error.details = { path: "/repo/app/WORKFLOW.md" };
  const loader = createCachedWorkflowLoader({
    status,
    loader: async () => {
      throw error;
    }
  });

  await assert.rejects(
    () => loader.load({
      config: {},
      card: { id: "card_1", board_id: "board_1" },
      route: { id: "route_1", fingerprint: "sha256:route" },
      workspace: { key: "workspace_app", sourceRepo: "/repo/app", path: "/tmp/workspace-app" }
    }),
    (thrown) => thrown.code === "WORKFLOW_FRONT_MATTER_INVALID"
  );

  const snapshot = status.status();
  assert.equal(snapshot.workflow_cache.recent_reload_errors[0].cache_hit, false);
  assert.equal(snapshot.workflow_cache.entries[0].status, "failed");
  assert.equal(snapshot.recent_failures.at(-1).failure_kind, "workflow_reload");
});
