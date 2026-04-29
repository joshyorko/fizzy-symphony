import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEtagCache } from "../src/etag-cache.js";

function configFixture(stateDir, overrides = {}) {
  return {
    fizzy: {
      account: "acct",
      api_url: "https://app.fizzy.test/api",
      token: "secret-token"
    },
    boards: {
      entries: [
        { id: "board_1", enabled: true },
        { id: "board_disabled", enabled: false }
      ]
    },
    polling: {
      use_etags: true,
      use_api_filters: true,
      api_filters: {
        tag_ids: ["tag_ready"],
        assignment_status: "unassigned"
      }
    },
    observability: { state_dir: stateDir },
    ...overrides
  };
}

test("ETag cache persists metadata and snapshots under observability.state_dir", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "fizzy-symphony-etags-"));
  const config = configFixture(stateDir);
  const cache = createEtagCache({ config });

  await cache.load();
  assert.equal(cache.get({ type: "board", id: "board_1" }), null);
  assert.equal(cache.stats().misses, 1);

  cache.set(
    { type: "board", id: "board_1" },
    {
      etag: "\"board-v1\"",
      snapshot: { id: "board_1", name: "Agents" }
    }
  );
  await cache.save();

  const onDisk = JSON.parse(await readFile(join(stateDir, "etag-cache.json"), "utf8"));
  assert.equal(onDisk.schema_version, "fizzy-symphony-etag-cache-v1");
  assert.equal(onDisk.context.account, "acct");
  assert.equal(onDisk.context.api_url, "https://app.fizzy.test/api");
  assert.match(onDisk.context.auth_fingerprint, /^sha256:/);
  assert.equal(JSON.stringify(onDisk).includes("secret-token"), false);

  const reloaded = createEtagCache({ config });
  await reloaded.load();
  const entry = reloaded.get({ type: "board", id: "board_1" });

  assert.equal(entry.etag, "\"board-v1\"");
  assert.deepEqual(entry.snapshot, { id: "board_1", name: "Agents" });
});

test("ETag cache invalidates when account, API URL, auth, board scope, or polling filters change", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "fizzy-symphony-etags-context-"));
  const baseConfig = configFixture(stateDir);
  const cache = createEtagCache({ config: baseConfig });

  await cache.load();
  cache.set({ type: "card", id: "card_1" }, { etag: "\"card-v1\"", snapshot: { id: "card_1" } });
  await cache.save();

  const cases = [
    ["account", { fizzy: { ...baseConfig.fizzy, account: "other" } }],
    ["api_url", { fizzy: { ...baseConfig.fizzy, api_url: "https://elsewhere.test/api" } }],
    ["auth", { fizzy: { ...baseConfig.fizzy, token: "rotated-token" } }],
    [
      "board scope",
      {
        boards: {
          entries: [
            { id: "board_1", enabled: true },
            { id: "board_2", enabled: true }
          ]
        }
      }
    ],
    [
      "polling filters",
      {
        polling: {
          ...baseConfig.polling,
          api_filters: { ...baseConfig.polling.api_filters, assignment_status: "assigned" }
        }
      }
    ]
  ];

  for (const [label, override] of cases) {
    const changed = createEtagCache({ config: configFixture(stateDir, override) });
    await changed.load();

    assert.equal(changed.get({ type: "card", id: "card_1" }), null, label);
    assert.equal(changed.stats().invalid, 1, label);
  }
});

test("ETag cache treats malformed files and invalid entries as a full-read fallback", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "fizzy-symphony-etags-invalid-"));
  const config = configFixture(stateDir);

  await writeFile(join(stateDir, "etag-cache.json"), "{not json", "utf8");
  const malformed = createEtagCache({ config });
  await malformed.load();
  assert.equal(malformed.get({ type: "board", id: "board_1" }), null);
  assert.equal(malformed.stats().invalid, 1);

  const invalidEntry = createEtagCache({ config });
  await invalidEntry.load();
  invalidEntry.set({ type: "user", id: "all" }, { etag: "\"users-v1\"", snapshot: [{ id: "user_1" }] });
  await invalidEntry.save();

  const file = JSON.parse(await readFile(join(stateDir, "etag-cache.json"), "utf8"));
  const [key] = Object.keys(file.entries);
  file.entries[key].etag = 42;
  await writeFile(join(stateDir, "etag-cache.json"), `${JSON.stringify(file)}\n`, "utf8");

  const reloaded = createEtagCache({ config });
  await reloaded.load();
  assert.equal(reloaded.get({ type: "user", id: "all" }), null);
  assert.equal(reloaded.stats().invalid, 1);
});
