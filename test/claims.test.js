import test from "node:test";
import assert from "node:assert/strict";

import { FizzySymphonyError } from "../src/errors.js";
import {
  applyClaimEventLog,
  canAcquireClaim,
  createBoardClaimStore,
  createClaimMarker,
  createReleaseMarker,
  inspectClaimMarkers,
  parseClaimMarker,
  readClaims,
  selectActiveClaim
} from "../src/claims.js";

const NOW = new Date("2026-04-29T12:00:00.000Z");

function route(overrides = {}) {
  return {
    id: "board:board_1:column:col_ready:golden:golden_1",
    fingerprint: "sha256:route",
    ...overrides
  };
}

function card(overrides = {}) {
  return {
    id: "card_1",
    board_id: "board_1",
    digest: "sha256:card",
    ...overrides
  };
}

function workspace(overrides = {}) {
  return {
    key: "workspace_app",
    identity_digest: "sha256:workspace",
    workspace_key: "workspace_app",
    workspace_identity_digest: "sha256:workspace",
    ...overrides
  };
}

function instance(overrides = {}) {
  return {
    id: "instance_a",
    daemon_version: "0.1.0",
    ...overrides
  };
}

function claim(overrides = {}) {
  return {
    claim_id: "claim_1",
    attempt_id: "attempt_1",
    run_id: "run_1",
    lease_ms: 900000,
    ...overrides
  };
}

function comment(id, body, createdAt) {
  return { id, body, created_at: createdAt.toISOString() };
}

function config(overrides = {}) {
  const { claims: claimOverrides = {}, ...rest } = overrides;
  return {
    instance: { id: "instance_a", daemon_version: "0.1.0" },
    fizzy: { bot_user_id: "bot_1" },
    claims: {
      mode: "structured_comment",
      assign_on_claim: false,
      watch_on_claim: false,
      lease_ms: 900000,
      steal_grace_ms: 30000,
      max_clock_skew_ms: 30000,
      ...claimOverrides
    },
    ...rest
  };
}

function fakeFizzy({ comments = [], listedComments, failPost = false } = {}) {
  const calls = [];
  const posted = [];
  const queues = Array.isArray(listedComments) ? [...listedComments] : null;

  return {
    calls,
    posted,
    async listComments({ card }) {
      calls.push(`list:${card.id}`);
      if (queues && queues.length > 0) return [...queues.shift(), ...comments];
      return comments;
    },
    async postComment({ card, body }) {
      calls.push(`post:${card.id}`);
      if (failPost) throw new Error("post failed");
      const createdAt = new Date(Date.parse(NOW.toISOString()) + posted.length).toISOString();
      const saved = { id: `posted_${posted.length + 1}`, body, created_at: createdAt };
      posted.push(saved);
      comments.push(saved);
      return saved;
    },
    async assignCard({ card, userId }) {
      calls.push(`assign:${card.id}:${userId}`);
      return { ok: true };
    },
    async watchCard({ card }) {
      calls.push(`watch:${card.id}`);
      return { ok: true };
    }
  };
}

function statusRecorder() {
  const claims = [];
  return {
    claims,
    recordClaim(claimState) {
      claims.push(claimState);
      return claimState;
    }
  };
}

test("claim markers round-trip as append-only JSON fenced Markdown", () => {
  const marker = createClaimMarker({
    claim: claim(),
    route: route(),
    card: card(),
    instance: instance(),
    workspace: workspace(),
    now: NOW
  });

  assert.match(marker.body, /<!-- fizzy-symphony-marker -->/);
  assert.match(marker.body, /fizzy-symphony:claim:v1/);
  assert.match(marker.body, /```json/);
  assert.deepEqual(marker.claim, {
    marker: "fizzy-symphony:claim:v1",
    claim_id: "claim_1",
    status: "claimed",
    card_id: "card_1",
    board_id: "board_1",
    card_digest: "sha256:card",
    route_id: "board:board_1:column:col_ready:golden:golden_1",
    route_fingerprint: "sha256:route",
    workspace_key: "workspace_app",
    workspace_identity_digest: "sha256:workspace",
    instance_id: "instance_a",
    attempt_id: "attempt_1",
    run_id: "run_1",
    started_at: "2026-04-29T12:00:00.000Z",
    renewed_at: "2026-04-29T12:00:00.000Z",
    expires_at: "2026-04-29T12:15:00.000Z",
    daemon_version: "0.1.0"
  });

  assert.deepEqual(parseClaimMarker(`operator note\n\n${marker.body}\n\nmore text`), marker.claim);
});

test("malformed claim markers throw structured FizzySymphonyError values", () => {
  assert.throws(
    () => parseClaimMarker("not a marker"),
    (error) => error instanceof FizzySymphonyError && error.code === "MALFORMED_CLAIM_MARKER"
  );

  assert.throws(
    () => parseClaimMarker("<!-- fizzy-symphony-marker -->\nfizzy-symphony:claim:v1\n\n```json\n{ nope\n```"),
    (error) => error instanceof FizzySymphonyError && error.code === "MALFORMED_CLAIM_MARKER"
  );

  assert.throws(
    () => parseClaimMarker([
      "<!-- fizzy-symphony-marker -->",
      "fizzy-symphony:claim:v1",
      "",
      "```json",
      JSON.stringify({ marker: "fizzy-symphony:claim:v1", claim_id: "claim_1" }),
      "```"
    ].join("\n")),
    (error) => (
      error instanceof FizzySymphonyError &&
      error.code === "MALFORMED_CLAIM_MARKER" &&
      error.details.missing.includes("run_id")
    )
  );
});

test("claim event logs apply renewals and releases so released claims do not block acquisition", () => {
  const first = createClaimMarker({
    claim: claim(),
    route: route(),
    card: card(),
    instance: instance(),
    workspace: workspace(),
    now: NOW
  });
  const renewedAt = new Date("2026-04-29T12:05:00.000Z");
  const renewed = createClaimMarker({
    claim: claim({ started_at: first.claim.started_at }),
    route: route(),
    card: card(),
    instance: instance(),
    workspace: workspace(),
    now: renewedAt
  });
  const releasedAt = new Date("2026-04-29T12:06:00.000Z");
  const released = createReleaseMarker({
    claim: renewed.claim,
    status: "released",
    now: releasedAt
  });

  const reduced = applyClaimEventLog([
    comment("comment_release", released.body, releasedAt),
    { id: "comment_noise", body: "operator note", created_at: "2026-04-29T12:03:00.000Z" },
    comment("comment_initial", first.body, NOW),
    comment("comment_renewed", renewed.body, renewedAt)
  ]);

  assert.equal(readClaims([{ body: "not a marker" }, comment("claim", first.body, NOW)]).length, 1);
  assert.equal(reduced.length, 1);
  assert.equal(reduced[0].claim_id, "claim_1");
  assert.equal(reduced[0].status, "released");
  assert.equal(reduced[0].active, false);
  assert.deepEqual(reduced[0].events.map((event) => event.status), ["claimed", "claimed", "released"]);
  assert.equal(selectActiveClaim(reduced, {
    cardId: "card_1",
    routeFingerprint: "sha256:route",
    now: new Date("2026-04-29T12:07:00.000Z")
  }), null);
  assert.deepEqual(canAcquireClaim(reduced, {
    cardId: "card_1",
    routeFingerprint: "sha256:route",
    now: new Date("2026-04-29T12:07:00.000Z"),
    stealGraceMs: 30000
  }), { ok: true, reason: "no_active_claim" });
});

test("unexpired claims block acquisition and expired claims are stealable only after grace", () => {
  const marker = createClaimMarker({
    claim: claim(),
    route: route(),
    card: card(),
    instance: instance(),
    workspace: workspace(),
    now: NOW
  });
  const claims = applyClaimEventLog([comment("comment_claim", marker.body, NOW)]);

  assert.equal(selectActiveClaim(claims, {
    cardId: "card_1",
    routeFingerprint: "sha256:route",
    now: new Date("2026-04-29T12:10:00.000Z")
  }).claim_id, "claim_1");
  assert.equal(canAcquireClaim(claims, {
    cardId: "card_1",
    routeFingerprint: "sha256:route",
    now: new Date("2026-04-29T12:10:00.000Z"),
    stealGraceMs: 30000
  }).reason, "active_claim");
  assert.equal(canAcquireClaim(claims, {
    cardId: "card_1",
    routeFingerprint: "sha256:route",
    now: new Date("2026-04-29T12:15:10.000Z"),
    stealGraceMs: 30000
  }).reason, "claim_steal_grace");
  assert.deepEqual(canAcquireClaim(claims, {
    cardId: "card_1",
    routeFingerprint: "sha256:route",
    now: new Date("2026-04-29T12:15:31.000Z"),
    stealGraceMs: 30000
  }), { ok: true, reason: "expired_stealable" });
});

test("route fingerprint mismatches remain visible but still block acquisition for the same card", () => {
  const oldRoute = createClaimMarker({
    claim: claim({ claim_id: "claim_old", attempt_id: "attempt_old", run_id: "run_old" }),
    route: route({ fingerprint: "sha256:old-route" }),
    card: card(),
    instance: instance({ id: "instance_old" }),
    workspace: workspace(),
    now: NOW
  });
  const reduced = applyClaimEventLog([comment("comment_old", oldRoute.body, NOW)]);

  assert.equal(reduced.length, 1);
  assert.equal(reduced[0].claim_id, "claim_old");
  assert.equal(reduced[0].route_fingerprint, "sha256:old-route");
  assert.equal(selectActiveClaim(reduced, {
    cardId: "card_1",
    routeFingerprint: "sha256:new-route",
    now: new Date("2026-04-29T12:10:00.000Z")
  }).claim_id, "claim_old");
  assert.equal(canAcquireClaim(reduced, {
    cardId: "card_1",
    routeFingerprint: "sha256:new-route",
    now: new Date("2026-04-29T12:10:00.000Z"),
    stealGraceMs: 30000
  }).reason, "active_claim");
});

test("board claim store posts a claim comment, rereads, assigns, and watches only after winning", async () => {
  const fizzy = fakeFizzy();
  const status = statusRecorder();
  const store = createBoardClaimStore({
    fizzy,
    status,
    ids: {
      claimId: () => "claim_a",
      attemptId: () => "attempt_a",
      runId: () => "run_a"
    }
  });

  const result = await store.acquire({
    config: config({ claims: { assign_on_claim: true, watch_on_claim: true } }),
    card: { ...card(), tags: ["agent-claimed"] },
    route: route(),
    workspace: workspace(),
    now: NOW
  });

  assert.equal(result.acquired, true);
  assert.equal(result.claim.claim_id, "claim_a");
  assert.equal(result.claim.expires_at, "2026-04-29T12:15:00.000Z");
  assert.deepEqual(fizzy.calls, [
    "list:card_1",
    "post:card_1",
    "list:card_1",
    "assign:card_1:bot_1",
    "watch:card_1"
  ]);
  assert.equal(readClaims(fizzy.posted).length, 1);
  assert.equal(status.claims.at(-1).status, "claimed");
});

test("board claim store blocks on live claims for the same card regardless of tags or route fingerprint", async () => {
  const live = createClaimMarker({
    claim: claim({ claim_id: "claim_live", attempt_id: "attempt_live", run_id: "run_live" }),
    route: route({ fingerprint: "sha256:old-route" }),
    card: card(),
    instance: instance({ id: "instance_other" }),
    workspace: workspace(),
    now: NOW
  });
  const fizzy = fakeFizzy({ comments: [comment("comment_live", live.body, NOW)] });
  const store = createBoardClaimStore({ fizzy });

  const result = await store.acquire({
    config: config(),
    card: { ...card(), tags: ["agent-claimed"] },
    route: route({ fingerprint: "sha256:new-route" }),
    workspace: workspace(),
    now: new Date("2026-04-29T12:05:00.000Z")
  });

  assert.equal(result.acquired, false);
  assert.equal(result.reason, "active_claim");
  assert.equal(result.live_claim.claim_id, "claim_live");
  assert.deepEqual(fizzy.calls, ["list:card_1"]);
});

test("board claim store posts lost when a deterministic claim race is won by another daemon", async () => {
  const other = createClaimMarker({
    claim: claim({
      claim_id: "claim_a",
      attempt_id: "attempt_other",
      run_id: "run_other",
      started_at: NOW
    }),
    route: route(),
    card: card(),
    instance: instance({ id: "instance_other" }),
    workspace: workspace(),
    now: NOW
  });
  const fizzy = fakeFizzy();
  const status = statusRecorder();
  fizzy.listComments = async ({ card }) => {
    fizzy.calls.push(`list:${card.id}`);
    if (fizzy.calls.filter((call) => call.startsWith("list:")).length === 1) return [];
    return [
      ...fizzy.posted,
      comment("comment_other", other.body, NOW)
    ];
  };
  const store = createBoardClaimStore({
    fizzy,
    status,
    ids: {
      claimId: () => "claim_b",
      attemptId: () => "attempt_b",
      runId: () => "run_b"
    }
  });

  const result = await store.acquire({
    config: config({ claims: { assign_on_claim: true, watch_on_claim: true } }),
    card: card(),
    route: route(),
    workspace: workspace(),
    now: NOW
  });

  assert.equal(result.acquired, false);
  assert.equal(result.reason, "lost_claim");
  assert.equal(result.live_claim.claim_id, "claim_a");
  assert.equal(readClaims(fizzy.posted).at(-1).status, "lost");
  assert.equal(status.claims.at(-1).status, "lost");
  assert.deepEqual(fizzy.calls, ["list:card_1", "post:card_1", "list:card_1", "post:card_1"]);
});

test("claim race winner treats starts within max clock skew as simultaneous and breaks ties by claim ID", async () => {
  const other = createClaimMarker({
    claim: claim({
      claim_id: "claim_z",
      attempt_id: "attempt_other",
      run_id: "run_other",
      started_at: "2026-04-29T11:59:50.000Z"
    }),
    route: route(),
    card: card(),
    instance: instance({ id: "instance_other" }),
    workspace: workspace(),
    now: new Date("2026-04-29T11:59:50.000Z")
  });
  const fizzy = fakeFizzy();
  fizzy.listComments = async ({ card }) => {
    fizzy.calls.push(`list:${card.id}`);
    if (fizzy.calls.filter((call) => call.startsWith("list:")).length === 1) return [];
    return [
      comment("comment_other", other.body, new Date("2026-04-29T11:59:50.000Z")),
      ...fizzy.posted
    ];
  };
  const store = createBoardClaimStore({
    fizzy,
    ids: {
      claimId: () => "claim_a",
      attemptId: () => "attempt_a",
      runId: () => "run_a"
    }
  });

  const result = await store.acquire({
    config: config(),
    card: card(),
    route: route(),
    workspace: workspace(),
    now: NOW
  });

  assert.equal(result.acquired, true);
  assert.equal(result.claim.claim_id, "claim_a");
});

test("expired claims are stealable only after grace and a second reread confirms they are still expired", async () => {
  const expired = createClaimMarker({
    claim: claim({ claim_id: "claim_old", attempt_id: "attempt_old", run_id: "run_old", lease_ms: 60000 }),
    route: route(),
    card: card(),
    instance: instance({ id: "instance_old" }),
    workspace: workspace(),
    now: new Date("2026-04-29T11:00:00.000Z")
  });
  const renewed = createClaimMarker({
    claim: {
      ...expired.claim,
      status: "renewed",
      expires_at: "2026-04-29T12:15:00.000Z"
    },
    route: route(),
    card: card(),
    instance: instance({ id: "instance_old" }),
    workspace: workspace(),
    now: new Date("2026-04-29T12:00:00.000Z")
  });
  const sleeps = [];
  const fizzy = fakeFizzy({
    listedComments: [
      [comment("comment_expired", expired.body, new Date("2026-04-29T11:00:00.000Z"))],
      [
        comment("comment_expired", expired.body, new Date("2026-04-29T11:00:00.000Z")),
        comment("comment_renewed", renewed.body, new Date("2026-04-29T12:00:00.000Z"))
      ]
    ]
  });
  const store = createBoardClaimStore({
    fizzy,
    sleep: async (ms) => sleeps.push(ms)
  });

  const result = await store.acquire({
    config: config({ claims: { steal_grace_ms: 30000 } }),
    card: card(),
    route: route(),
    workspace: workspace(),
    now: NOW
  });

  assert.equal(result.acquired, false);
  assert.equal(result.reason, "active_claim_after_grace");
  assert.deepEqual(sleeps, [30000]);
  assert.deepEqual(fizzy.calls, ["list:card_1", "list:card_1"]);
});

test("expired claims can be stolen after grace when the reread still has no live claim", async () => {
  const expired = createClaimMarker({
    claim: claim({ claim_id: "claim_old", attempt_id: "attempt_old", run_id: "run_old", lease_ms: 60000 }),
    route: route(),
    card: card(),
    instance: instance({ id: "instance_old" }),
    workspace: workspace(),
    now: new Date("2026-04-29T11:00:00.000Z")
  });
  const sleeps = [];
  const fizzy = fakeFizzy({
    listedComments: [
      [comment("comment_expired", expired.body, new Date("2026-04-29T11:00:00.000Z"))],
      [comment("comment_expired", expired.body, new Date("2026-04-29T11:00:00.000Z"))],
      []
    ]
  });
  const store = createBoardClaimStore({
    fizzy,
    sleep: async (ms) => sleeps.push(ms),
    ids: {
      claimId: () => "claim_new",
      attemptId: () => "attempt_new",
      runId: () => "run_new"
    }
  });

  const result = await store.acquire({
    config: config({ claims: { steal_grace_ms: 30000 } }),
    card: card(),
    route: route(),
    workspace: workspace(),
    now: NOW
  });

  assert.equal(result.acquired, true);
  assert.equal(result.reason, "expired_stealable");
  assert.deepEqual(sleeps, [30000]);
});

test("renewal and release append structured comments and failed release is visible in status", async () => {
  const fizzy = fakeFizzy();
  const status = statusRecorder();
  const store = createBoardClaimStore({ fizzy, status });
  const ownedClaim = createClaimMarker({
    claim: claim(),
    route: route(),
    card: card(),
    instance: instance(),
    workspace: workspace(),
    now: NOW
  }).claim;

  const renewal = await store.renew({
    config: config(),
    card: card(),
    claim: ownedClaim,
    now: new Date("2026-04-29T12:05:00.000Z")
  });
  const release = await store.release({
    config: config(),
    card: card(),
    claim: renewal.claim,
    status: "completed",
    now: new Date("2026-04-29T12:10:00.000Z")
  });

  assert.equal(renewal.renewed, true);
  assert.equal(renewal.claim.status, "renewed");
  assert.equal(release.released, true);
  assert.equal(release.claim.status, "completed");
  assert.deepEqual(readClaims(fizzy.posted).map((claim) => claim.status), ["renewed", "completed"]);

  const failingStatus = statusRecorder();
  const failingStore = createBoardClaimStore({ fizzy: fakeFizzy({ failPost: true }), status: failingStatus });
  const failed = await failingStore.release({
    config: config(),
    card: card(),
    claim: ownedClaim,
    status: "failed",
    now: NOW
  });

  assert.equal(failed.released, false);
  assert.equal(failingStatus.claims.at(-1).status, "release_failed");
  assert.equal(failingStatus.claims.at(-1).preserve_workspace, true);
});

test("startup claim inspection reports self expired, self live, other live, terminal, and malformed markers tolerantly", () => {
  const selfExpired = createClaimMarker({
    claim: claim({
      claim_id: "claim_expired",
      attempt_id: "attempt_expired",
      run_id: "run_expired",
      lease_expires_at: "2026-04-29T11:59:00.000Z"
    }),
    route: route(),
    card: card(),
    instance: instance({ id: "instance_a" }),
    workspace: workspace(),
    now: new Date("2026-04-29T11:45:00.000Z")
  });
  const selfLive = createClaimMarker({
    claim: claim({
      claim_id: "claim_self_live",
      attempt_id: "attempt_self_live",
      run_id: "run_self_live",
      lease_expires_at: "2026-04-29T12:30:00.000Z"
    }),
    route: route(),
    card: card(),
    instance: instance({ id: "instance_a" }),
    workspace: workspace(),
    now: NOW
  });
  const otherLive = createClaimMarker({
    claim: claim({
      claim_id: "claim_other_live",
      attempt_id: "attempt_other_live",
      run_id: "run_other_live",
      lease_expires_at: "2026-04-29T12:30:00.000Z"
    }),
    route: route(),
    card: card(),
    instance: instance({ id: "instance_b" }),
    workspace: workspace(),
    now: NOW
  });
  const terminalClaim = createClaimMarker({
    claim: claim({
      claim_id: "claim_terminal",
      attempt_id: "attempt_terminal",
      run_id: "run_terminal",
      lease_expires_at: "2026-04-29T12:30:00.000Z"
    }),
    route: route(),
    card: card(),
    instance: instance({ id: "instance_b" }),
    workspace: workspace(),
    now: NOW
  });
  const terminal = createReleaseMarker({
    claim: terminalClaim.claim,
    status: "completed",
    now: new Date("2026-04-29T12:02:00.000Z")
  });

  const report = inspectClaimMarkers([
    comment("expired", selfExpired.body, new Date("2026-04-29T11:45:00.000Z")),
    comment("self-live", selfLive.body, NOW),
    comment("other-live", otherLive.body, NOW),
    comment("terminal", terminal.body, new Date("2026-04-29T12:02:00.000Z")),
    { id: "malformed", body: "<!-- fizzy-symphony-marker -->\nfizzy-symphony:claim:v1\n\n```json\n{nope\n```" },
    { id: "non-authoritative", body: "fizzy-symphony:claim:v1 {\"claim_id\":\"not-fenced\"}" }
  ], {
    instanceId: "instance_a",
    now: "2026-04-29T12:00:00.000Z"
  });

  assert.deepEqual(report.recoverable_expired_self_claims.map((entry) => entry.claim_id), ["claim_expired"]);
  assert.deepEqual(report.live_self_claim_warnings.map((entry) => entry.claim_id), ["claim_self_live"]);
  assert.deepEqual(report.other_live_claims.map((entry) => entry.claim_id), ["claim_other_live"]);
  assert.deepEqual(report.terminal_claims.map((entry) => entry.claim_id), ["claim_terminal"]);
  assert.deepEqual(report.warnings.map((entry) => entry.code).sort(), [
    "CLAIM_MARKER_MALFORMED",
    "CLAIM_MARKER_MALFORMED",
    "CLAIM_SELF_LIVE_ON_STARTUP"
  ].sort());
});
