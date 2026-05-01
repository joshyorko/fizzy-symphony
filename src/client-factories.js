import { createCodexCliAppServerRunner } from "./codex-cli-app-server-runner.js";
import { FizzySymphonyError } from "./errors.js";
import { createFizzyClient } from "./fizzy-client.js";

export const DEFAULT_FIZZY_API_URL = "https://app.fizzy.do";

export function createCliFizzyClient(options = {}) {
  const config = resolveFizzyClientConfig(options);
  requireLiveFizzyConfig(config);
  return createFizzyClient({
    config,
    fetch: options.fetch,
    transport: options.transport,
    normalize: options.normalize,
    etagCache: options.etagCache,
    sdkFactory: options.sdkFactory,
    sdkRootClient: options.sdkRootClient
  });
}

export function createCliRunner(options = {}) {
  return createCodexCliAppServerRunner(options.runnerOptions ?? {});
}

export function resolveFizzyClientConfig(options = {}) {
  const {
    config = {},
    env = process.env,
    defaultApiUrl = DEFAULT_FIZZY_API_URL
  } = options;
  const fizzy = config.fizzy ?? {};
  const token = firstNonEmpty(fizzy.token, env.FIZZY_API_TOKEN, env.FIZZY_TOKEN, env.FIZYY_TOKEN);
  const apiUrl = firstNonEmpty(fizzy.api_url, env.FIZZY_API_URL, defaultApiUrl);

  return {
    ...config,
    fizzy: {
      ...fizzy,
      token: token ?? "",
      api_url: apiUrl ?? ""
    }
  };
}

export function requireLiveFizzyConfig(config = {}) {
  if (!nonEmpty(config.fizzy?.token)) {
    throw new FizzySymphonyError(
      "FIZZY_CREDENTIALS_MISSING",
      "Fizzy API credentials are required for live setup and startup validation.",
      {
        required: ["fizzy.token", "FIZZY_API_TOKEN"],
        remediation: "Set FIZZY_API_TOKEN or configure fizzy.token, then rerun the command. Use setup --template-only only when you want a non-live config template."
      }
    );
  }

  if (!nonEmpty(config.fizzy?.api_url)) {
    throw new FizzySymphonyError(
      "FIZZY_API_URL_MISSING",
      "A Fizzy API URL is required for live setup and startup validation.",
      {
        required: ["fizzy.api_url", "FIZZY_API_URL"],
        remediation: `Set FIZZY_API_URL or configure fizzy.api_url. The default public API URL is ${DEFAULT_FIZZY_API_URL}.`
      }
    );
  }

  return config;
}

function firstNonEmpty(...values) {
  return values.find(nonEmpty);
}

function nonEmpty(value) {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}
