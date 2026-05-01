import { createSdkBackedFizzyClient } from "./fizzy-sdk-adapter.js";
import {
  FizzyApiError,
  createFetchTransport,
  createLegacyFizzyClient,
  verifyWebhookRequest,
  verifyWebhookSignature
} from "./fizzy-http-client.js";

export {
  FizzyApiError,
  createFetchTransport,
  createLegacyFizzyClient,
  verifyWebhookRequest,
  verifyWebhookSignature
};

export function createFizzyClient(options = {}) {
  if (typeof options.transport === "function" || typeof options.fetch === "function") {
    return createLegacyFizzyClient(options);
  }

  return createSdkBackedFizzyClient(options);
}
