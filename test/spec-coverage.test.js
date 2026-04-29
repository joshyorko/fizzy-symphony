import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const REQUIRED_GROUPS = [
  "Config generation",
  "Startup validation",
  "Golden-ticket parsing",
  "Unsafe completion policy rejection",
  "Card routing precedence",
  "Fizzy API usage",
  "Workspace isolation",
  "Port allocation",
  "Multi-instance claim behavior",
  "Safe cleanup",
  "Runner health checks",
  "Status snapshot",
  "Event ingestion"
];

const VALID_STATUSES = new Set(["passing", "newly covered", "deferred"]);

test("SPEC 28 coverage checklist maps every required group with a valid status", async () => {
  const body = await readFile(new URL("../docs/spec-coverage.md", import.meta.url), "utf8");

  for (const group of REQUIRED_GROUPS) {
    const section = sectionFor(body, group);
    assert.ok(section, `missing SPEC 28 coverage section: ${group}`);

    const status = section.match(/^- Status: (.+)$/mu)?.[1]?.trim();
    assert.ok(VALID_STATUSES.has(status), `${group} has invalid status: ${status}`);

    if (status === "deferred") {
      assert.match(section, /^- Reason: .+/mu, `${group} deferred status must include a reason`);
      assert.match(section, /^- Follow-up: `[^`]+`/mu, `${group} deferred status must include a follow-up card`);
    } else {
      assert.match(section, /^- Tests: `[^`]+`/mu, `${group} passing/newly covered status must name concrete tests`);
    }
  }
});

function sectionFor(body, group) {
  const heading = `### ${group}\n`;
  const start = body.indexOf(heading);
  if (start === -1) return "";

  const sectionStart = start + heading.length;
  const nextHeading = body.indexOf("\n### ", sectionStart);
  return body.slice(sectionStart, nextHeading === -1 ? undefined : nextHeading);
}
