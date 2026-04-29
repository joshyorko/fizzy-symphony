import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalJson,
  cardDigest,
  completionSlug,
  digest,
  normalizedTags,
  normalizeTag,
  sanitizeWorkspaceSegment,
  shortDigest
} from "../src/domain.js";

function baseRoute(overrides = {}) {
  return {
    id: "board:board_1:column:col_ready:golden:golden_1",
    fingerprint: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    ...overrides
  };
}

function baseCard(overrides = {}) {
  return {
    id: "card_1",
    number: 42,
    title: "Add domain primitives",
    description: "Implement deterministic shared helpers.",
    column_id: "col_ready",
    tags: ["#Feature", { name: "workspace-App" }],
    steps: [
      { id: "step_1", title: "Write tests", checked: true },
      { id: "step_2", title: "Implement code", checked: false }
    ],
    comments: [{ id: "comment_1", body: "Human context belongs to the card digest." }],
    closed: false,
    postponed: false,
    last_active_at: "2026-04-29T12:00:00-04:00",
    ...overrides
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("canonicalJson sorts object keys recursively and preserves array order", () => {
  assert.equal(
    canonicalJson({
      z: 1,
      a: [
        { c: 3, b: 2 },
        { b: 1, a: 2 }
      ]
    }),
    "{\"a\":[{\"b\":2,\"c\":3},{\"a\":2,\"b\":1}],\"z\":1}"
  );
});

test("digest and shortDigest use sha256 over canonical JSON", () => {
  const value = { b: 1, a: 2 };

  assert.equal(
    digest(value),
    "sha256:d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772"
  );
  assert.equal(shortDigest(value), "d3626ac30a87");
  assert.equal(shortDigest(value, 8), "d3626ac3");
});

test("normalizeTag and normalizedTags trim hashes, lowercase, and keep first-seen uniqueness", () => {
  assert.equal(normalizeTag(" ##Agent-Rerun "), "agent-rerun");
  assert.equal(normalizeTag({ name: " #Workspace-App " }), "workspace-app");
  assert.equal(normalizeTag({ title: "Move-To-Done" }), "move-to-done");
  assert.equal(normalizeTag({ slug: "Model-GPT-5" }), "model-gpt-5");

  assert.deepEqual(
    normalizedTags({
      tags: [" #Codex ", { name: "codex" }, { slug: "#Workspace-App" }, "", { title: "Move-To-Done" }, { label: "Priority-1" }]
    }),
    ["codex", "workspace-app", "move-to-done", "priority-1"]
  );
});

test("completionSlug and sanitizeWorkspaceSegment produce route-safe strings", () => {
  assert.equal(completionSlug(" Ready -- For   Agents "), "ready-for-agents");
  assert.equal(completionSlug("QA-review  Done"), "qa-review-done");

  assert.equal(sanitizeWorkspaceSegment("board 1/app#card:42"), "board_1_app_card_42");
  assert.equal(sanitizeWorkspaceSegment("A-Z_a.b~c"), "A-Z_a.b_c");
});

test("cardDigest changes when route-relevant card fields change", () => {
  const card = baseCard();
  const route = baseRoute();
  const original = cardDigest(card, route);

  const mutations = [
    ["id", (copy) => { copy.id = "card_2"; }],
    ["number", (copy) => { copy.number = 43; }],
    ["title", (copy) => { copy.title = "Changed title"; }],
    ["description", (copy) => { copy.description = "Changed description"; }],
    ["step checked state", (copy) => { copy.steps[1].checked = true; }],
    ["non-daemon tag", (copy) => { copy.tags.push("priority-2"); }],
    ["source column", (copy) => { copy.column_id = "col_other"; }],
    ["closed state", (copy) => { copy.closed = true; }],
    ["postponed state", (copy) => { copy.postponed = true; }],
    ["last active time", (copy) => { copy.last_active_at = "2026-04-29T16:00:01.000Z"; }]
  ];

  for (const [field, mutate] of mutations) {
    const changed = clone(card);
    mutate(changed);
    assert.notEqual(cardDigest(changed, route), original, `${field} should affect the digest`);
  }

  assert.notEqual(cardDigest(card, baseRoute({ id: "other-route" })), original, "route id should affect the digest");
  assert.notEqual(
    cardDigest(card, baseRoute({ fingerprint: "sha256:2222222222222222222222222222222222222222222222222222222222222222" })),
    original,
    "route fingerprint should affect the digest"
  );
});

test("cardDigest normalizes equivalent last_active_at timestamp forms", () => {
  const route = baseRoute();

  assert.equal(
    cardDigest(baseCard({ last_active_at: "2026-04-29T12:00:00-04:00" }), route),
    cardDigest(baseCard({ last_active_at: "2026-04-29T16:00:00.000Z" }), route)
  );
});

test("cardDigest excludes only explicit daemon-owned tags and marker comments", () => {
  const route = baseRoute();
  const humanComment = { id: "comment_1", body: "Human context belongs to the card digest." };
  const daemonMarker = {
    id: "comment_daemon",
    body: [
      "<!-- fizzy-symphony-marker -->",
      "fizzy-symphony:completion:v1",
      "",
      "```json",
      "{\"kind\":\"completion\"}",
      "```"
    ].join("\n")
  };

  const withoutDaemonState = baseCard({
    tags: ["feature", "agent-rerun"],
    comments: [humanComment]
  });
  const withDaemonState = baseCard({
    tags: [
      "feature",
      "agent-rerun",
      "agent-claimed",
      "agent-completed-abcdef123456",
      "agent-completion-failed-abcdef123456"
    ],
    comments: [humanComment, daemonMarker]
  });

  assert.equal(cardDigest(withDaemonState, route), cardDigest(withoutDaemonState, route));

  assert.notEqual(
    cardDigest(baseCard({ tags: ["feature"], comments: [humanComment] }), route),
    cardDigest(withoutDaemonState, route),
    "agent-rerun is a human dispatch signal, not a daemon-owned tag"
  );
  assert.notEqual(
    cardDigest(baseCard({ tags: ["feature", "agent-rerun"], comments: [humanComment, { id: "comment_2", body: "Please add docs." }] }), route),
    cardDigest(withoutDaemonState, route),
    "non-marker comments remain part of the card digest"
  );
});

test("cardDigest treats live Fizzy rich-text comment bodies like plain text", () => {
  const route = baseRoute();
  const plainText = "Human context belongs to the card digest.";

  assert.equal(
    cardDigest(baseCard({ comments: [{ id: "comment_1", body: plainText }] }), route),
    cardDigest(baseCard({ comments: [{ id: "comment_1", body: { plain_text: plainText, html: "<p>ignored</p>" } }] }), route)
  );
});
