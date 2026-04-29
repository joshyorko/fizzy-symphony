import { createEtagCache } from "./etag-cache.js";

export function createFizzyClient(options = {}) {
  const {
    config = {},
    transport,
    normalize = (_resource, body) => body,
    etagCache = createEtagCache({ config })
  } = options;

  if (typeof transport !== "function") {
    throw new TypeError("createFizzyClient requires a transport function.");
  }

  async function requestResource(resource, request) {
    const useEtags = config.polling?.use_etags !== false && etagCache;
    const headers = { ...(request.headers ?? {}) };
    let lookupResult = null;

    if (useEtags) {
      await etagCache.load();
      lookupResult = etagCache.lookup(resource);
      if (lookupResult.entry) {
        headers["If-None-Match"] = lookupResult.entry.etag;
      }
    }

    const response = await transport({
      method: request.method ?? "GET",
      path: request.path,
      query: request.query ?? {},
      headers
    });
    const status = Number(response?.status ?? response?.statusCode ?? 200);

    if (status === 304) {
      if (lookupResult?.entry) {
        etagCache.recordHit?.();
        return {
          status,
          ok: true,
          not_modified: true,
          resource,
          etag: lookupResult.entry.etag,
          snapshot: lookupResult.entry.snapshot,
          data: lookupResult.entry.snapshot
        };
      }

      etagCache?.recordInvalid?.();
      return {
        status,
        ok: false,
        not_modified: true,
        resource,
        etag: null,
        snapshot: null,
        data: null
      };
    }

    if (status < 200 || status >= 300) {
      const error = new Error(`Fizzy API request failed with status ${status}.`);
      error.status = status;
      error.response = response;
      throw error;
    }

    if (lookupResult?.entry) {
      etagCache.recordMiss?.();
    }

    const body = response?.body ?? response?.data ?? null;
    const snapshot = normalize(resource, body);
    const etag = responseEtag(response);

    if (useEtags && typeof etag === "string" && etag.length > 0) {
      etagCache.set(resource, { etag, snapshot });
      await etagCache.save();
    }

    return {
      status,
      ok: true,
      not_modified: false,
      resource,
      etag: etag ?? null,
      snapshot,
      data: snapshot
    };
  }

  return {
    getBoard(boardId) {
      return requestResource(
        { type: "board", id: boardId },
        { path: `/boards/${encodePathPart(boardId)}` }
      );
    },

    getCard(cardId) {
      return requestResource(
        { type: "card", id: cardId },
        { path: `/cards/${encodePathPart(cardId)}` }
      );
    },

    listComments(cardId) {
      return requestResource(
        { type: "comment", id: cardId },
        { path: `/cards/${encodePathPart(cardId)}/comments` }
      );
    },

    listTags(account = config.fizzy?.account) {
      return requestResource(
        { type: "tag", id: account ?? "default" },
        { path: `/accounts/${encodePathPart(account)}/tags` }
      );
    },

    listUsers(account = config.fizzy?.account) {
      return requestResource(
        { type: "user", id: account ?? "default" },
        { path: `/accounts/${encodePathPart(account)}/users` }
      );
    },

    listWebhooks(account = config.fizzy?.account) {
      return requestResource(
        { type: "webhook", id: account ?? "default" },
        { path: `/accounts/${encodePathPart(account)}/webhooks` }
      );
    },

    listCards(options = {}) {
      const query = options.query ?? options;
      return requestResource(
        { type: "card_collection", query },
        { path: "/cards", query }
      );
    },

    listGoldenCards(options = {}) {
      const query = { ...(options.query ?? options), indexed_by: "golden" };
      return requestResource(
        { type: "golden_card_collection", query },
        { path: "/cards", query }
      );
    },

    etagStats() {
      return etagCache?.stats?.() ?? { hits: 0, misses: 0, invalid: 0 };
    }
  };
}

function responseEtag(response) {
  const headers = response?.headers ?? {};
  return response?.etag ?? headers.etag ?? headers.ETag ?? headers.Etag ?? null;
}

function encodePathPart(value) {
  return encodeURIComponent(String(value ?? ""));
}
