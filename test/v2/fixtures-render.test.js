import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createCockpitModel } from "../../src/v2/cockpit/model.ts";
import { renderCockpitText } from "../../src/v2/cockpit/renderer.ts";
import { normalizeStatus } from "../../src/v2/core/status.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "v2");
const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));

test("every fixture loads, normalizes, and renders without throwing", () => {
  assert.ok(fixtures.length >= 11, `expected >= 11 fixtures, found ${fixtures.length}`);
  for (const name of fixtures) {
    const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
    const status = normalizeStatus(raw.status);
    const model = createCockpitModel({ status, events: raw.events ?? [] });
    const text = renderCockpitText(model);
    assert.match(text, /FIZZY-SYMPHONY COCKPIT/, `fixture ${name} should render header`);
    assert.match(text, /ACTIONS/, `fixture ${name} should render actions`);
  }
});

test("hazard states are visually obvious in rendered text", () => {
  const dirty = JSON.parse(readFileSync(join(FIXTURE_DIR, "dirty-worktree.json"), "utf8"));
  const dirtyModel = createCockpitModel({ status: normalizeStatus(dirty.status) });
  assert.match(renderCockpitText(dirtyModel), /Spill \/ hazard/);

  const failed = JSON.parse(readFileSync(join(FIXTURE_DIR, "failed-run.json"), "utf8"));
  const failedModel = createCockpitModel({ status: normalizeStatus(failed.status) });
  assert.match(renderCockpitText(failedModel), /Jammed machine|RUNNER_ERROR/);

  const blocked = JSON.parse(readFileSync(join(FIXTURE_DIR, "blocked-runner.json"), "utf8"));
  const blockedModel = createCockpitModel({ status: normalizeStatus(blocked.status) });
  assert.match(renderCockpitText(blockedModel), /Factory cannot close/);
});
