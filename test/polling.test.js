import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCandidateQuery,
  buildGoldenCardQuery,
  discoverPollingCandidates,
  refreshGoldenTicketRegistry
} from "../src/polling.js";

function configFixture(overrides = {}) {
  return {
    fizzy: { account: "acct" },
    boards: {
      entries: [
        { id: "board_1", enabled: true },
        { id: "board_2", enabled: true },
        { id: "board_disabled", enabled: false }
      ]
    },
    polling: {
      use_api_filters: true,
      api_filters: {
        tag_ids: ["tag_ready", "tag_codex"],
        assignee_ids: ["user_bot"],
        assignment_status: "unassigned",
        indexed_by: "last_active",
        sorted_by: "priority",
        terms: ["codex", "agent"]
      }
    },
    ...overrides
  };
}

const routes = [
  { board_id: "board_1", source_column_id: "col_ready" },
  { board_id: "board_2", source_column_id: "col_review" }
];

test("candidate discovery builds API filters from watched boards, routed columns, and configured filters", async () => {
  const config = configFixture();
  const calls = [];
  const candidates = await discoverPollingCandidates({
    config,
    routes,
    fizzy: {
      async listCards({ query }) {
        calls.push(query);
        return { data: [{ id: "card_1", board_id: "board_1", column_id: "col_ready" }] };
      }
    }
  });

  assert.deepEqual(calls, [
    {
      board_ids: ["board_1", "board_2"],
      column_ids: ["col_ready", "col_review"],
      tag_ids: ["tag_ready", "tag_codex"],
      assignee_ids: ["user_bot"],
      assignment_status: "unassigned",
      indexed_by: "last_active",
      sorted_by: "priority",
      terms: ["codex", "agent"]
    }
  ]);
  assert.deepEqual(candidates, [{ id: "card_1", board_id: "board_1", column_id: "col_ready" }]);
});

test("configured board_ids and column_ids narrow candidate filters while local validation remains separate", () => {
  const query = buildCandidateQuery({
    config: configFixture({
      polling: {
        use_api_filters: true,
        api_filters: {
          board_ids: ["board_2"],
          column_ids: ["col_review"],
          indexed_by: "updated_at",
          sorted_by: "last_active_desc",
          terms: ["follow-up"]
        }
      }
    }),
    routes
  });

  assert.deepEqual(query, {
    board_ids: ["board_2"],
    column_ids: ["col_review"],
    indexed_by: "updated_at",
    sorted_by: "last_active_desc",
    terms: ["follow-up"]
  });
});

test("empty configured board and column filters fall back to watched boards and routes", () => {
  const query = buildCandidateQuery({
    config: configFixture({
      polling: {
        use_api_filters: true,
        api_filters: {
          board_ids: [],
          column_ids: []
        }
      }
    }),
    routes
  });

  assert.deepEqual(query, {
    board_ids: ["board_1", "board_2"],
    column_ids: ["col_ready", "col_review"]
  });
});

test("native golden-card discovery uses indexed_by=golden and rejects unsafe golden state locally", async () => {
  const config = configFixture();
  assert.deepEqual(buildGoldenCardQuery({ config }), {
    board_ids: ["board_1", "board_2"],
    indexed_by: "golden"
  });

  const calls = [];
  const discovered = await refreshGoldenTicketRegistry({
    config,
    fizzy: {
      async getBoard(boardId) {
        calls.push(["getBoard", boardId]);
        return {
          id: boardId,
          columns: [
            { id: "col_ready", name: "Ready" },
            { id: "col_done", name: "Done" }
          ]
        };
      },
      async listGoldenCards({ query }) {
        calls.push(["listGoldenCards", query]);
        return {
          data: [
            {
              id: "golden_1",
              board: { id: "board_1" },
              column: { id: "col_ready" },
              golden: true,
              tags: ["agent-instructions", "move-to-done"]
            }
          ]
        };
      }
    }
  });

  assert.deepEqual(calls[0], ["listGoldenCards", { board_ids: ["board_1", "board_2"], indexed_by: "golden" }]);
  assert.equal(discovered.routes[0].golden_card_id, "golden_1");

  await assert.rejects(
    () => refreshGoldenTicketRegistry({
      config,
      fizzy: {
        async getBoard(boardId) {
          return {
            id: boardId,
            columns: [
              { id: "col_ready", name: "Ready" },
              { id: "col_done", name: "Done" }
            ]
          };
        },
        async listGoldenCards() {
          return {
            data: [
              {
                id: "golden_a",
                board_id: "board_1",
                column_id: "col_ready",
                golden: true,
                tags: ["agent-instructions", "move-to-done"]
              },
              {
                id: "golden_b",
                board_id: "board_1",
                column_id: "col_ready",
                golden: true,
                tags: ["agent-instructions", "move-to-done"]
              }
            ]
          };
        }
      }
    }),
    (error) => error.code === "DUPLICATE_GOLDEN_TICKETS"
  );
});
