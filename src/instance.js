import { resolve } from "node:path";
import { hostname as osHostname } from "node:os";

import { shortDigest } from "./domain.js";

export function resolveInstanceIdentity(config = {}, options = {}) {
  const explicitId = config.instance?.id;
  const explicitLabel = config.instance?.label;
  const hostname = options.hostname ?? osHostname();

  if (explicitId && explicitId !== "auto") {
    return {
      id: explicitId,
      label: explicitLabel && explicitLabel !== "auto" ? explicitLabel : explicitId,
      auto: false
    };
  }

  const inputs = identityInputs(config, { ...options, hostname });
  return {
    id: `fsym-${shortDigest(inputs)}`,
    label: explicitLabel && explicitLabel !== "auto" ? explicitLabel : `${hostname}:${inputs.watched_board_ids.join(",")}`,
    auto: true,
    inputs
  };
}

function identityInputs(config, options) {
  return {
    config_path: resolve(options.configPath ?? "config.json"),
    hostname: options.hostname,
    workspace_root: resolve(config.workspaces?.root ?? ".fizzy-symphony/workspaces"),
    watched_board_ids: (config.boards?.entries ?? [])
      .filter((entry) => entry.enabled !== false)
      .map((entry) => entry.id)
      .sort()
  };
}
