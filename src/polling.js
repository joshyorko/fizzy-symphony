import { discoverGoldenTicketRoutes } from "./validation.js";

export function buildCandidateQuery({ config = {}, routes = [] } = {}) {
  if (config.polling?.use_api_filters === false) return {};
  const configured = config.polling?.api_filters ?? {};
  return omitEmpty({
    board_ids: configured.board_ids ?? watchedBoardIds(config),
    column_ids: configured.column_ids ?? unique(routes.map((route) => route.source_column_id).filter(Boolean)),
    tag_ids: configured.tag_ids,
    assignee_ids: configured.assignee_ids,
    assignment_status: configured.assignment_status,
    indexed_by: configured.indexed_by,
    sorted_by: configured.sorted_by,
    terms: configured.terms
  });
}

export function buildGoldenCardQuery({ config = {} } = {}) {
  return {
    board_ids: watchedBoardIds(config),
    indexed_by: "golden"
  };
}

export async function discoverPollingCandidates({ config = {}, routes = [], fizzy } = {}) {
  const response = await fizzy.listCards({ query: buildCandidateQuery({ config, routes }) });
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.cards)) return response.cards;
  return [];
}

export async function refreshGoldenTicketRegistry({ config = {}, fizzy } = {}) {
  const query = buildGoldenCardQuery({ config });
  const goldenResponse = await fizzy.listGoldenCards({ query });
  const goldenCards = Array.isArray(goldenResponse) ? goldenResponse : goldenResponse?.data ?? [];
  const boardsById = new Map();

  for (const boardId of watchedBoardIds(config)) {
    const board = await fizzy.getBoard(boardId);
    boardsById.set(boardId, { ...board, cards: [] });
  }

  for (const card of goldenCards) {
    if (!boardsById.has(card.board_id)) continue;
    boardsById.get(card.board_id).cards.push(card);
  }

  return {
    routes: discoverGoldenTicketRoutes([...boardsById.values()], routeOptionsFromConfig(config))
  };
}

function routeOptionsFromConfig(config) {
  return {
    boards: Object.fromEntries(
      (config.boards?.entries ?? []).map((board) => [
        board.id,
        {
          defaults: board.defaults ?? {},
          allowed_card_overrides: board.defaults?.allowed_card_overrides,
          rerun_policy: config.routing?.rerun,
          managed_tags: config.managed_tags
        }
      ])
    )
  };
}

function watchedBoardIds(config) {
  return (config.boards?.entries ?? [])
    .filter((entry) => entry.enabled !== false)
    .map((entry) => entry.id);
}

function unique(values) {
  return [...new Set(values)];
}

function omitEmpty(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (Array.isArray(entry)) return entry.length > 0;
      return entry !== undefined && entry !== null && entry !== "";
    })
  );
}
