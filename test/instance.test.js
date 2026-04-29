import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { resolveInstanceIdentity } from "../src/instance.js";
import { coordinationConfig, tempProject } from "./helpers.js";

test("resolveInstanceIdentity prefers explicit instance.id over auto hash inputs", async () => {
  const root = await tempProject("fizzy-symphony-instance-explicit-");
  const config = coordinationConfig(root, {
    instance: { id: "laptop-main", label: "Local Main" }
  });

  const identity = resolveInstanceIdentity(config, {
    configPath: join(root, "config.json"),
    hostname: "host-a"
  });

  assert.equal(identity.id, "laptop-main");
  assert.equal(identity.label, "Local Main");
  assert.equal(identity.auto, false);
});

test("resolveInstanceIdentity builds stable auto IDs from canonical inputs", async () => {
  const root = await tempProject("fizzy-symphony-instance-auto-");
  const configPath = join(root, "nested", "..", "config.json");
  const workspaceRoot = join(root, "workspace-root");
  const first = coordinationConfig(root, {
    workspaces: { root: workspaceRoot },
    boards: {
      entries: [
        { id: "board_z", enabled: true },
        { id: "board_a", enabled: true },
        { id: "board_disabled", enabled: false }
      ]
    }
  });
  const reordered = coordinationConfig(root, {
    workspaces: { root: workspaceRoot },
    boards: {
      entries: [
        { id: "board_disabled", enabled: false },
        { id: "board_a", enabled: true },
        { id: "board_z", enabled: true }
      ]
    }
  });

  const firstIdentity = resolveInstanceIdentity(first, { configPath, hostname: "host-a" });
  const reorderedIdentity = resolveInstanceIdentity(reordered, {
    configPath: join(root, "config.json"),
    hostname: "host-a"
  });
  const otherWorkspace = resolveInstanceIdentity(
    coordinationConfig(root, { workspaces: { root: join(root, "other-workspace") } }),
    { configPath: join(root, "config.json"), hostname: "host-a" }
  );

  assert.equal(firstIdentity.id, reorderedIdentity.id);
  assert.equal(firstIdentity.auto, true);
  assert.deepEqual(firstIdentity.inputs.watched_board_ids, ["board_a", "board_z"]);
  assert.equal(firstIdentity.inputs.config_path, join(root, "config.json"));
  assert.notEqual(firstIdentity.id, otherWorkspace.id);
});

