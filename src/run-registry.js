import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA_VERSION = "fizzy-symphony-run-attempt-v1";

export function createRunRegistry({ stateDir } = {}) {
  const runsDir = join(stateDir, "runs");

  async function writeAttempt(attempt = {}) {
    const record = { schema_version: SCHEMA_VERSION, ...attempt };
    const path = attemptPath(record.attempt_id);
    const body = `${JSON.stringify(record, null, 2)}\n`;
    await mkdir(runsDir, { recursive: true });
    const tmpPath = join(runsDir, `.${safeFilePart(record.attempt_id)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmpPath, body, "utf8");
    await rename(tmpPath, path);
    return { path, bytes: Buffer.byteLength(body), record };
  }

  async function readAttempts() {
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const attempts = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        attempts.push(JSON.parse(await readFile(join(runsDir, entry.name), "utf8")));
      } catch {
        continue;
      }
    }

    return attempts.sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")));
  }

  async function updateAttempt(attemptId, updates = {}) {
    const existing = (await readAttempts()).find((entry) => entry.attempt_id === attemptId);
    if (!existing) throw new Error(`Run attempt not found: ${attemptId}`);
    const updated = { ...existing, ...updates };
    await writeAttempt(updated);
    return updated;
  }

  function attemptPath(attemptId) {
    return join(runsDir, `${safeFilePart(attemptId)}.json`);
  }

  return {
    writeAttempt,
    readAttempts,
    updateAttempt,
    attemptPath
  };
}

function safeFilePart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/gu, "_");
}
