import { readFile as readFileAsync } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { FizzySymphonyError } from "./errors.js";
import { asArray, cardDescription, commentBody, richText } from "./fizzy-normalize.js";

const defaultFileSystem = { readFile: readFileAsync };
const BUILT_IN_FALLBACK_WORKFLOW = [
  "Fizzy card and golden-ticket instructions are the primary workflow.",
  "",
  "Use the card request, checklist, comments, and golden-ticket route as the source of truth.",
  "Inspect relevant repository files, make the smallest safe change, run appropriate local checks, and summarize the result."
].join("\n");

export function parseWorkflow(text) {
  const source = stripBom(String(text ?? ""));
  const { frontMatterText, bodyText } = splitMarkdown(source);
  const frontMatter = frontMatterText === null ? {} : parseFrontMatter(frontMatterText);

  return {
    frontMatter,
    body: bodyText.trim()
  };
}

export async function loadWorkflow({ workspace = {}, config = {}, fs = defaultFileSystem } = {}) {
  const candidates = workflowCandidates(workspace);
  const searched = [];

  for (const candidate of candidates) {
    searched.push(candidate.path);
    const loaded = await tryReadWorkflow(candidate, fs);
    if (loaded.missing) continue;
    return loaded.workflow;
  }

  const fallbackPath = config.workflow?.fallback_path;
  if (config.workflow?.fallback_enabled && fallbackPath) {
    const candidate = { path: fallbackPath, source: "fallback" };
    searched.push(candidate.path);
    const loaded = await tryReadWorkflow(candidate, fs);
    if (!loaded.missing) return loaded.workflow;
  }

  if (config.workflow?.fallback_enabled) {
    return {
      ...parseWorkflow(BUILT_IN_FALLBACK_WORKFLOW),
      path: "",
      source: "built_in_fallback"
    };
  }

  throw new FizzySymphonyError("WORKFLOW_MISSING", "No WORKFLOW.md was found for the resolved workspace.", {
    searched,
    fallback_enabled: Boolean(config.workflow?.fallback_enabled),
    fallback_path: fallbackPath ?? ""
  });
}

export function renderPrompt({
  workflow,
  board = {},
  column = {},
  route = {},
  card = {},
  attempt = 1,
  workspace = {},
  workpad = null,
  completion = {}
} = {}) {
  const parsedWorkflow = typeof workflow === "string" ? parseWorkflow(workflow) : workflow;
  if (!parsedWorkflow?.body && parsedWorkflow?.body !== "") {
    throw new FizzySymphonyError("WORKFLOW_INVALID", "renderPrompt requires a parsed workflow or workflow text.");
  }

  const context = { workflow: parsedWorkflow, board, column, route, card, attempt, workspace, completion };
  const renderedPolicy = renderTemplate(parsedWorkflow.body, context);
  const completionPolicy = {
    route_completion: route.completion ?? null,
    daemon_completion: completion
  };
  const frontMatter = parsedWorkflow.frontMatter ?? parsedWorkflow.front_matter ?? {};

  return compactSections([
    "Fizzy result comment format",
    "Return the final response as HTML suitable for a Fizzy rich-text comment. Use only ordinary content tags such as <p>, <strong>, <em>, <ul>/<li>, <ol>/<li>, <h3>, <pre><code>, and <blockquote>. Do not return Markdown fences unless they are inside <pre><code>.",
    `Workflow front matter:\n\`\`\`json\n${JSON.stringify(frontMatter, null, 2)}\n\`\`\``,
    "Workflow prompt body",
    renderedPolicy,
    "Fizzy task context",
    renderRecord("Board", {
      id: board.id,
      name: board.name ?? board.label,
      url: board.url
    }),
    renderRecord("Column", {
      id: column.id,
      name: column.name ?? column.label
    }),
    renderRecord("Golden-ticket route", {
      id: route.id,
      golden_card_id: route.golden_card_id,
      backend: route.backend,
      model: route.model,
      workspace: route.workspace,
      persona: route.persona,
      fingerprint: route.fingerprint
    }),
    renderCard(card),
    `Attempt: ${displayScalar(attempt)}`,
    renderRecord("Workspace", {
      id: workspace.id,
      path: workspace.path,
      source_repo: workspace.sourceRepo ?? workspace.source_repo ?? workspace.repo,
      branch: workspace.branch,
      metadata_path: workspace.metadataPath ?? workspace.metadata_path
    }),
    `Active workpad:\n\`\`\`json\n${JSON.stringify(workpadState(workpad), null, 2)}\n\`\`\``,
    `Completion policy:\n\`\`\`json\n${JSON.stringify(completionPolicy, null, 2)}\n\`\`\``
  ]);
}

export class WorkflowCache {
  constructor(loaderOptions = {}, options = {}) {
    this.loaderOptions = loaderOptions;
    this.loader = options.loader ?? loadWorkflow;
    this.workflow = null;
    this.reloadError = null;
  }

  async reload(overrides = {}) {
    try {
      const workflow = await this.loader({ ...this.loaderOptions, ...overrides });
      this.workflow = workflow;
      this.reloadError = null;
      return { ok: true, workflow };
    } catch (error) {
      const structured = structuredWorkflowError(error);
      this.reloadError = structured;
      if (!this.workflow) throw structured;
      return { ok: false, workflow: this.workflow, error: structured };
    }
  }
}

export function createWorkflowCache(loaderOptions = {}, options = {}) {
  return new WorkflowCache(loaderOptions, options);
}

export function createCachedWorkflowLoader(options = {}) {
  const {
    status,
    loader = loadWorkflow
  } = options;
  const caches = new Map();

  return {
    caches,
    async load(context = {}) {
      const key = workflowCacheKey(context);
      let cache = caches.get(key);
      if (!cache) {
        cache = createWorkflowCache({}, { loader });
        caches.set(key, cache);
      }

      try {
        const result = await cache.reload(context);
        status?.recordWorkflowReload?.({
          ...workflowReloadContext(context, result.workflow),
          key,
          ok: result.ok,
          cache_hit: result.ok === false,
          error: result.error
        });
        return result.workflow;
      } catch (error) {
        status?.recordWorkflowReload?.({
          ...workflowReloadContext(context),
          key,
          ok: false,
          cache_hit: false,
          error
        });
        throw error;
      }
    }
  };
}

function workflowCandidates(workspace) {
  const sourceRepo = workspace.sourceRepo ?? workspace.source_repo ?? workspace.repo ?? workspace.config?.repo;
  const workspacePath = workspace.path ?? workspace.workspacePath ?? workspace.workspace_path;
  const explicitPath = workspace.config?.workflow_path ?? workspace.workflow_path ?? workspace.workflowPath;
  const candidates = [];

  if (explicitPath) {
    candidates.push({
      path: resolveWorkflowPath(explicitPath, sourceRepo ?? workspacePath),
      source: "explicit"
    });
  }
  if (sourceRepo) {
    candidates.push({ path: join(sourceRepo, "WORKFLOW.md"), source: "source_repo" });
  }
  if (workspacePath) {
    candidates.push({ path: join(workspacePath, "WORKFLOW.md"), source: "workspace" });
  }

  return uniqueCandidates(candidates);
}

function workflowCacheKey({ config = {}, workspace = {} } = {}) {
  const sourceRepo = workspace.sourceRepo ?? workspace.source_repo ?? workspace.repo ?? workspace.config?.repo ?? "";
  const workspacePath = workspace.path ?? workspace.workspacePath ?? workspace.workspace_path ?? "";
  return JSON.stringify({
    source_repo: sourceRepo,
    workspace_path: sourceRepo ? "" : workspacePath,
    workflow_path: workspace.config?.workflow_path ?? workspace.workflow_path ?? workspace.workflowPath ?? "",
    fallback_path: config.workflow?.fallback_path ?? "",
    fallback_enabled: Boolean(config.workflow?.fallback_enabled)
  });
}

function workflowReloadContext({ card = {}, route = {}, workspace = {} } = {}, workflow = null) {
  return {
    card,
    route,
    workspace,
    workflow,
    workflow_path: workflow?.path ?? workspace.config?.workflow_path ?? workspace.workflow_path ?? workspace.workflowPath
  };
}

function resolveWorkflowPath(workflowPath, base) {
  if (isAbsolute(workflowPath)) return workflowPath;
  return resolve(base ?? process.cwd(), workflowPath);
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

async function tryReadWorkflow(candidate, fs) {
  let content;
  try {
    content = await readText(fs, candidate.path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { missing: true };
    throw new FizzySymphonyError("WORKFLOW_READ_FAILED", "Unable to read workflow file.", {
      path: candidate.path,
      cause: error.message
    });
  }

  try {
    return {
      missing: false,
      workflow: {
        ...parseWorkflow(content),
        path: candidate.path,
        source: candidate.source
      }
    };
  } catch (error) {
    throw structuredWorkflowError(error, { path: candidate.path });
  }
}

async function readText(fs, path) {
  const reader = fs.readFile?.bind(fs) ?? fs.promises?.readFile?.bind(fs.promises);
  if (!reader) {
    throw new FizzySymphonyError("WORKFLOW_FS_INVALID", "Workflow file system adapter must provide readFile.");
  }
  return reader(path, "utf8");
}

function splitMarkdown(text) {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");

  if (lines[0] !== "---") {
    return { frontMatterText: null, bodyText: normalized };
  }

  const closeIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closeIndex === -1) {
    throw new FizzySymphonyError("WORKFLOW_FRONT_MATTER_INVALID", "Workflow front matter is missing a closing delimiter.", {
      reason: "missing_delimiter"
    });
  }

  return {
    frontMatterText: lines.slice(1, closeIndex).join("\n"),
    bodyText: lines.slice(closeIndex + 1).join("\n")
  };
}

function parseFrontMatter(text) {
  const lines = compactYamlLines(text);
  if (lines.length === 0) return {};
  if (lines[0].text.startsWith("- ")) {
    throw frontMatterError("Workflow front matter must be a map/object.", {
      reason: "not_map",
      line: lines[0].line
    });
  }
  if (lines[0].indent !== 0) {
    throw frontMatterError("Workflow front matter must start at the left margin.", {
      reason: "invalid_indent",
      line: lines[0].line
    });
  }

  const [value, index] = parseYamlMap(lines, 0, 0);
  if (index !== lines.length) {
    throw frontMatterError("Workflow front matter contains invalid YAML for the supported subset.", {
      line: lines[index].line
    });
  }
  return value;
}

function compactYamlLines(text) {
  return text.split("\n").flatMap((rawLine, index) => {
    if (/^\s*\t/u.test(rawLine)) {
      throw frontMatterError("Workflow front matter indentation must use spaces.", {
        reason: "tabs",
        line: index + 1
      });
    }

    const withoutTrailingSpace = rawLine.replace(/\s+$/u, "");
    const text = withoutTrailingSpace.trim();
    if (!text || text.startsWith("#")) return [];

    return [{
      line: index + 1,
      indent: withoutTrailingSpace.match(/^ */u)[0].length,
      text: withoutTrailingSpace.trimStart()
    }];
  });
}

function parseYamlMap(lines, start, indent) {
  const object = {};
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw frontMatterError("Workflow front matter contains unexpected indentation.", {
        reason: "invalid_indent",
        line: line.line
      });
    }
    if (line.text.startsWith("- ")) break;

    const match = line.text.match(/^([A-Za-z0-9_.-]+):(?:\s+(.*)|\s*)$/u);
    if (!match) {
      throw frontMatterError("Workflow front matter map entries must use `key: value` syntax.", {
        reason: "invalid_syntax",
        line: line.line
      });
    }

    const key = match[1];
    const rawValue = match[2];
    if (rawValue !== undefined) {
      object[key] = parseYamlScalar(rawValue, line.line);
      index += 1;
      continue;
    }

    const next = lines[index + 1];
    if (!next || next.indent <= indent) {
      object[key] = {};
      index += 1;
    } else if (next.text.startsWith("- ")) {
      const [value, nextIndex] = parseYamlList(lines, index + 1, next.indent);
      object[key] = value;
      index = nextIndex;
    } else {
      const [value, nextIndex] = parseYamlMap(lines, index + 1, next.indent);
      object[key] = value;
      index = nextIndex;
    }
  }

  return [object, index];
}

function parseYamlList(lines, start, indent) {
  const array = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent > indent || !line.text.startsWith("- ")) {
      throw frontMatterError("Workflow front matter contains an invalid list item.", {
        reason: "invalid_list",
        line: line.line
      });
    }

    const itemText = line.text.slice(2).trim();
    if (!itemText) {
      const next = lines[index + 1];
      if (!next || next.indent <= indent) {
        array.push(null);
        index += 1;
      } else if (next.text.startsWith("- ")) {
        const [value, nextIndex] = parseYamlList(lines, index + 1, next.indent);
        array.push(value);
        index = nextIndex;
      } else {
        const [value, nextIndex] = parseYamlMap(lines, index + 1, next.indent);
        array.push(value);
        index = nextIndex;
      }
      continue;
    }

    array.push(parseYamlScalar(itemText, line.line));
    index += 1;
  }

  return [array, index];
}

function parseYamlScalar(rawValue, line) {
  const value = rawValue.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/u.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/u.test(value)) return Number(value);
  if (value.startsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw frontMatterError("Workflow front matter contains an invalid double-quoted scalar.", {
        reason: "invalid_scalar",
        line,
        cause: error.message
      });
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) {
      throw frontMatterError("Workflow front matter contains an invalid single-quoted scalar.", {
        reason: "invalid_scalar",
        line
      });
    }
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value;
}

function renderTemplate(template, context) {
  return String(template).replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/gu, (_, variable) => {
    const value = lookupDottedValue(context, variable);
    if (value === undefined) {
      throw new FizzySymphonyError(
        "WORKFLOW_TEMPLATE_UNKNOWN_VARIABLE",
        `Unknown workflow template variable: ${variable}`,
        { variable }
      );
    }
    return templateValue(value);
  });
}

function lookupDottedValue(context, variable) {
  let value = context;
  for (const part of variable.split(".")) {
    if (value === null || value === undefined || !Object.hasOwn(Object(value), part)) return undefined;
    value = value[part];
  }
  return value;
}

function templateValue(value) {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function renderCard(card) {
  return compactSections([
    renderRecord("Work card", {
      id: card.id,
      title: card.title ?? card.name,
      assignees: formatInlineList(card.assignees, personName)
    }),
    `Description:\n${displayBlock(cardDescription(card))}`,
    renderSteps(card.steps),
    renderList("Tags", card.tags, tagName),
    renderList("Comments", card.comments, commentLine),
    `URL: ${displayScalar(card.url ?? card.html_url)}`
  ]);
}

function renderRecord(title, values) {
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `- ${key}: ${displayScalar(value)}`);

  return `${title}:\n${lines.length > 0 ? lines.join("\n") : "- none"}`;
}

function renderSteps(steps = []) {
  if (!Array.isArray(steps) || steps.length === 0) return "Steps:\n- none";
  return `Steps:\n${asArray(steps).map((step) => {
    const completed = Boolean(step?.completed ?? step?.done ?? step?.checked);
    const title = typeof step === "string" ? step : richText(step?.title ?? step?.name ?? step?.body ?? step?.description ?? "");
    return `- [${completed ? "x" : " "}] ${title}`;
  }).join("\n")}`;
}

function renderList(title, items = [], formatter = displayScalar) {
  if (!Array.isArray(items) || items.length === 0) return `${title}:\n- none`;
  return `${title}:\n${items.map((item) => `- ${formatter(item)}`).join("\n")}`;
}

function formatInlineList(items = [], formatter = displayScalar) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items.map(formatter).join(", ");
}

function commentLine(comment) {
  if (typeof comment === "string") return comment;
  const author = personName(comment.author ?? comment.user ?? comment.created_by);
  const body = commentBody(comment);
  return author ? `${author}: ${body}` : body;
}

function workpadState(workpad) {
  if (!workpad) return { status: "unavailable" };
  return workpad;
}

function personName(person) {
  if (typeof person === "string") return person;
  return person?.name ?? person?.username ?? person?.id ?? "";
}

function tagName(tag) {
  if (typeof tag === "string") return tag;
  return tag?.name ?? tag?.label ?? tag?.slug ?? tag?.id ?? "";
}

function compactSections(sections) {
  return sections
    .map((section) => String(section ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function displayBlock(value) {
  if (value === undefined || value === null || value === "") return "(none)";
  return String(value).trim();
}

function displayScalar(value) {
  if (value === undefined || value === null || value === "") return "(none)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function frontMatterError(message, details = {}) {
  return new FizzySymphonyError("WORKFLOW_FRONT_MATTER_INVALID", message, details);
}

function structuredWorkflowError(error, details = {}) {
  if (error instanceof FizzySymphonyError) {
    return new FizzySymphonyError(error.code, error.message, { ...error.details, ...details });
  }
  if (error?.code) {
    return new FizzySymphonyError(error.code, error.message, { ...(error.details ?? {}), ...details });
  }
  return new FizzySymphonyError("WORKFLOW_ERROR", error.message, details);
}
