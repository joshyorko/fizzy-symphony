import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function tempProject(prefix = "fizzy-symphony-") {
  return mkdtemp(join(tmpdir(), prefix));
}

export function coordinationConfig(root, overrides = {}) {
  const server = {
    host: "127.0.0.1",
    port: "auto",
    port_allocation: "next_available",
    base_port: 4567,
    registry_dir: join(root, ".fizzy-symphony", "run", "instances"),
    heartbeat_interval_ms: 5000,
    ...(overrides.server ?? {})
  };

  return {
    instance: { id: "auto", label: "auto", ...(overrides.instance ?? {}) },
    boards: {
      entries: overrides.boards?.entries ?? [
        { id: "board_b", label: "B", enabled: true },
        { id: "board_a", label: "A", enabled: true },
        { id: "board_disabled", label: "Disabled", enabled: false }
      ]
    },
    server,
    workspaces: {
      root: overrides.workspaces?.root ?? join(root, ".fizzy-symphony", "workspaces")
    }
  };
}

