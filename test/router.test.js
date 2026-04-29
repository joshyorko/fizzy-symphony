import test from "node:test";
import assert from "node:assert/strict";

import { routeCard, sortDispatchCandidates } from "../src/router.js";
import { cardDigest } from "../src/domain.js";

function board(overrides = {}) {
  return {
    id: "board_1",
    name: "Agents",
    columns: [
      { id: "col_ready", name: "Ready" },
      { id: "col_review", name: "Review" },
      { id: "col_done", name: "Done" }
    ],
    ...overrides
  };
}

function route(overrides = {}) {
  return {
    id: "board:board_1:column:col_ready:golden:golden_ready",
    board_id: "board_1",
    source_column_id: "col_ready",
    golden_card_id: "golden_ready",
    fingerprint: "sha256:route",
    backend: "codex",
    model: "gpt-5",
    workspace: "app",
    persona: "repo-agent",
    priority: undefined,
    completion: { policy: "move_to_column", target_column_id: "col_done", target_column_name: "Done" },
    allowed_card_overrides: {
      backend: false,
      model: false,
      workspace: false,
      persona: false,
      priority: true,
      completion: false
    },
    ...overrides
  };
}

function card(overrides = {}) {
  return {
    id: "card_1",
    number: 10,
    board_id: "board_1",
    column_id: "col_ready",
    title: "Build the thing",
    golden: false,
    closed: false,
    postponed: false,
    tags: [],
    last_active_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function config(overrides = {}) {
  return {
    boards: { entries: [{ id: "board_1", enabled: true }] },
    routing: { allow_postponed_cards: false },
    completion: { allow_card_completion_override: false },
    workspaces: { registry: { app: { repo: "." }, docs: { repo: "." } } },
    ...overrides
  };
}

test("routeCard ignores golden tickets", () => {
  const decision = routeCard({
    board: board(),
    card: card({ golden: true }),
    routes: [route()],
    config: config()
  });

  assert.equal(decision.action, "ignore");
  assert.equal(decision.spawn, false);
});

test("routeCard ignores cards that are not on a watched board or routed column", () => {
  assert.equal(
    routeCard({
      board: board(),
      card: card({ board_id: "board_2" }),
      routes: [route()],
      config: config()
    }).action,
    "ignore"
  );

  assert.equal(
    routeCard({
      board: board(),
      card: card({ column_id: "col_review" }),
      routes: [route()],
      config: config()
    }).action,
    "ignore"
  );
});

test("routeCard ignores closed and postponed cards unless postponed dispatch is allowed", () => {
  assert.equal(
    routeCard({
      board: board(),
      card: card({ closed: true }),
      routes: [route()],
      config: config()
    }).action,
    "ignore"
  );

  assert.equal(
    routeCard({
      board: board(),
      card: card({ postponed: true }),
      routes: [route()],
      config: config()
    }).action,
    "ignore"
  );

  assert.equal(
    routeCard({
      board: board(),
      card: card({ postponed: true }),
      routes: [route()],
      config: config({ routing: { allow_postponed_cards: true } })
    }).action,
    "spawn"
  );
});

test("routeCard ignores cards with a live unexpired claim and spawns after expiry", () => {
  const futureClaim = {
    card_id: "card_1",
    status: "claimed",
    expires_at: "2999-01-01T00:00:00.000Z"
  };
  const expiredClaim = {
    card_id: "card_1",
    status: "claimed",
    expires_at: "2000-01-01T00:00:00.000Z"
  };

  assert.equal(
    routeCard({
      board: board(),
      card: card(),
      routes: [route()],
      config: config(),
      activeClaims: [futureClaim]
    }).action,
    "ignore"
  );

  assert.equal(
    routeCard({
      board: board(),
      card: card(),
      routes: [route()],
      config: config(),
      activeClaims: [expiredClaim]
    }).action,
    "spawn"
  );
});

test("routeCard ignores no-repeat completion markers unless agent-rerun is present", () => {
  const activeCard = card();
  const activeRoute = route();
  const marker = {
    kind: "completion",
    card_id: "card_1",
    route_id: "board:board_1:column:col_ready:golden:golden_ready",
    route_fingerprint: "sha256:route",
    card_digest: cardDigest(activeCard, activeRoute),
    no_repeat: true
  };

  assert.equal(
    routeCard({
      board: board(),
      card: activeCard,
      routes: [activeRoute],
      config: config(),
      completedMarkers: [marker]
    }).action,
    "ignore"
  );

  const rerun = routeCard({
    board: board(),
    card: card({ tags: ["agent-rerun"] }),
    routes: [activeRoute],
    config: config(),
    completedMarkers: [marker]
  });

  assert.equal(rerun.action, "spawn");
  assert.equal(rerun.rerun_requested, true);
});

test("routeCard rejects stale no-repeat markers by route fingerprint and allows content-change rerun only when opted in", () => {
  const activeCard = card();
  const activeRoute = route({
    rerun_policy: { mode: "explicit_tag_or_route_change" }
  });
  const currentDigest = cardDigest(activeCard, activeRoute);

  assert.equal(
    routeCard({
      board: board(),
      card: activeCard,
      routes: [activeRoute],
      config: config(),
      completedMarkers: [{
        kind: "completion",
        card_id: "card_1",
        route_id: activeRoute.id,
        route_fingerprint: "sha256:old-route",
        card_digest: currentDigest,
        no_repeat: true
      }]
    }).action,
    "spawn"
  );

  assert.equal(
    routeCard({
      board: board(),
      card: card({ title: "Changed title" }),
      routes: [activeRoute],
      config: config(),
      completedMarkers: [{
        kind: "completion",
        card_id: "card_1",
        route_id: activeRoute.id,
        route_fingerprint: activeRoute.fingerprint,
        card_digest: currentDigest,
        no_repeat: true
      }]
    }).action,
    "spawn"
  );

  assert.equal(
    routeCard({
      board: board(),
      card: card({ title: "Changed title" }),
      routes: [route()],
      config: config(),
      completedMarkers: [{
        kind: "completion",
        card_id: "card_1",
        route_id: activeRoute.id,
        route_fingerprint: activeRoute.fingerprint,
        card_digest: currentDigest,
        no_repeat: true
      }]
    }).reason,
    "no-repeat-completion"
  );
});

test("routeCard ignores current completion-failure markers unless agent-rerun is present", () => {
  const activeCard = card();
  const activeRoute = route();
  const marker = {
    kind: "completion_failed",
    card_id: "card_1",
    route_id: "board:board_1:column:col_ready:golden:golden_ready",
    route_fingerprint: "sha256:route",
    card_digest: cardDigest(activeCard, activeRoute)
  };

  assert.equal(
    routeCard({
      board: board(),
      card: activeCard,
      routes: [activeRoute],
      config: config(),
      completionFailureMarkers: [marker]
    }).action,
    "ignore"
  );

  assert.equal(
    routeCard({
      board: board(),
      card: card({ tags: ["agent-rerun"] }),
      routes: [activeRoute],
      config: config(),
      completionFailureMarkers: [marker]
    }).action,
    "spawn"
  );
});

test("routeCard treats completion-failure markers as current only for matching fingerprints and digest rules", () => {
  const activeCard = card();
  const activeRoute = route({ rerun_policy: { mode: "explicit_tag_or_route_change" } });
  const currentDigest = cardDigest(activeCard, activeRoute);

  assert.equal(
    routeCard({
      board: board(),
      card: activeCard,
      routes: [activeRoute],
      config: config(),
      completionFailureMarkers: [{
        kind: "completion_failed",
        card_id: "card_1",
        route_id: activeRoute.id,
        route_fingerprint: "sha256:old-route",
        card_digest: currentDigest
      }]
    }).action,
    "spawn"
  );

  assert.equal(
    routeCard({
      board: board(),
      card: card({ title: "Changed title" }),
      routes: [activeRoute],
      config: config(),
      completionFailureMarkers: [{
        kind: "completion_failed",
        card_id: "card_1",
        route_id: activeRoute.id,
        route_fingerprint: activeRoute.fingerprint,
        card_digest: currentDigest
      }]
    }).action,
    "spawn"
  );
});

test("routeCard parses allowed card override tags into the effective route", () => {
  const decision = routeCard({
    board: board(),
    card: card({
      tags: [
        "#backend-codex",
        "#model-gpt-5.1",
        "#workspace-docs",
        "#persona-maintainer",
        "#priority-2",
        "#complete-comment-once",
        "#agent-rerun"
      ]
    }),
    routes: [
      route({
        allowed_card_overrides: {
          backend: true,
          model: true,
          workspace: true,
          persona: true,
          priority: true,
          completion: true
        }
      })
    ],
    config: config({ completion: { allow_card_completion_override: true } })
  });

  assert.equal(decision.action, "spawn");
  assert.equal(decision.route.backend, "codex");
  assert.equal(decision.route.model, "gpt-5.1");
  assert.equal(decision.route.workspace, "docs");
  assert.equal(decision.route.persona, "maintainer");
  assert.equal(decision.route.priority, 2);
  assert.deepEqual(decision.route.completion, { policy: "comment_once" });
  assert.equal(decision.overrides.priority, 2);
  assert.equal(decision.rerun_requested, true);
});

test("routeCard fails validation visibly for disallowed recognized override tags", () => {
  const decision = routeCard({
    board: board(),
    card: card({ tags: ["workspace-docs"] }),
    routes: [route()],
    config: config()
  });

  assert.equal(decision.action, "fail-validation");
  assert.equal(decision.spawn, false);
  assert.equal(decision.code, "CARD_OVERRIDE_NOT_ALLOWED");
  assert.match(decision.message, /workspace/u);
  assert.match(decision.comment.body, /workspace-docs/u);
});

test("routeCard fails validation visibly for same-family conflicting card tags", () => {
  const decision = routeCard({
    board: board(),
    card: card({ tags: ["priority-1", "priority-2"] }),
    routes: [route()],
    config: config()
  });

  assert.equal(decision.action, "fail-validation");
  assert.equal(decision.code, "CONFLICTING_PRIORITY_TAGS");
  assert.match(decision.comment.body, /priority-1/u);
  assert.match(decision.comment.body, /priority-2/u);
});

test("routeCard fails validation visibly for unknown workspace overrides", () => {
  const decision = routeCard({
    board: board(),
    card: card({ tags: ["workspace-missing"] }),
    routes: [
      route({
        allowed_card_overrides: {
          backend: false,
          model: false,
          workspace: true,
          persona: false,
          priority: true,
          completion: false
        }
      })
    ],
    config: config()
  });

  assert.equal(decision.action, "fail-validation");
  assert.equal(decision.code, "UNKNOWN_WORKSPACE");
  assert.match(decision.comment.body, /workspace-missing/u);
});

test("sortDispatchCandidates orders spawn decisions by explicit priority, card priority, age, and number", () => {
  const decisions = [
    routeCard({
      board: board(),
      card: card({ id: "old", number: 5, last_active_at: "2024-01-01T00:00:00.000Z" }),
      routes: [route()],
      config: config()
    }),
    routeCard({
      board: board(),
      card: card({ id: "explicit-low", number: 4, tags: ["priority-5"] }),
      routes: [route()],
      config: config()
    }),
    routeCard({
      board: board(),
      card: card({ id: "card-priority", number: 3, priority: 1 }),
      routes: [route()],
      config: config()
    }),
    routeCard({
      board: board(),
      card: card({ id: "ignored", golden: true }),
      routes: [route()],
      config: config()
    }),
    routeCard({
      board: board(),
      card: card({ id: "explicit-high", number: 2, tags: ["priority-1"] }),
      routes: [route()],
      config: config()
    }),
    routeCard({
      board: board(),
      card: card({ id: "new", number: 6, last_active_at: "2025-01-01T00:00:00.000Z" }),
      routes: [route()],
      config: config()
    })
  ];

  assert.deepEqual(
    sortDispatchCandidates(decisions).map((decision) => decision.card.id),
    ["explicit-high", "explicit-low", "card-priority", "old", "new"]
  );
});
