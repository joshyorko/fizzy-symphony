import test from "node:test";
import assert from "node:assert/strict";

import {
  createGitSourceCacheManager,
  hasEmbeddedGitCredentials,
  isRemoteGitUrl,
  managedGitSourceCachePath,
  redactGitRemoteUrl
} from "../src/git-source-cache.js";

test("isRemoteGitUrl recognizes supported remote Git URL forms", () => {
  assert.equal(isRemoteGitUrl("https://github.com/OWNER/REPO.git"), true);
  assert.equal(isRemoteGitUrl("ssh://git@github.com/OWNER/REPO.git"), true);
  assert.equal(isRemoteGitUrl("git@github.com:OWNER/REPO.git"), true);
  assert.equal(isRemoteGitUrl("file:///tmp/repo.git"), true);
  assert.equal(isRemoteGitUrl("/tmp/repo"), false);
  assert.equal(isRemoteGitUrl("."), false);
});

test("redactGitRemoteUrl strips embedded credentials and cache paths are digest-based", () => {
  const remote = "https://user:secret@example.test/owner/repo.git";
  const redacted = redactGitRemoteUrl(remote);
  const cachePath = managedGitSourceCachePath("/tmp/fizzy-cache", remote);

  assert.equal(redacted, "https://example.test/owner/repo.git");
  assert.equal(redactGitRemoteUrl("ssh://git@example.test/owner/repo.git"), "ssh://git@example.test/owner/repo.git");
  assert.equal(redactGitRemoteUrl("ssh://git:secret@example.test/owner/repo.git"), "ssh://git@example.test/owner/repo.git");
  assert.equal(redactGitRemoteUrl("git@example.test:owner/repo.git"), "git@example.test:owner/repo.git");
  assert.match(cachePath, /\/tmp\/fizzy-cache\/git-[a-f0-9]{16}$/u);
  assert.equal(cachePath, managedGitSourceCachePath("/tmp/fizzy-cache", redacted));
});

test("hasEmbeddedGitCredentials only flags URL userinfo credentials", () => {
  assert.equal(hasEmbeddedGitCredentials("https://user:secret@example.test/owner/repo.git"), true);
  assert.equal(hasEmbeddedGitCredentials("https://user@example.test/owner/repo.git"), true);
  assert.equal(hasEmbeddedGitCredentials("https://example.test/owner/repo.git"), false);
  assert.equal(hasEmbeddedGitCredentials("ssh://git@example.test/owner/repo.git"), false);
  assert.equal(hasEmbeddedGitCredentials("ssh://git:secret@example.test/owner/repo.git"), true);
  assert.equal(hasEmbeddedGitCredentials("git@example.test:owner/repo.git"), false);
});

test("createGitSourceCacheManager rejects embedded HTTPS credentials with redacted details", async () => {
  const calls = [];
  const manager = createGitSourceCacheManager({
    fs: {
      async mkdir() {},
      async access() {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
    },
    exec: async (file, args, options) => {
      calls.push([file, args, options.cwd]);
      return { stdout: "", stderr: "", exit_code: 0 };
    }
  });

  await assert.rejects(
    () => manager.resolve({
      sourceCacheRoot: "/tmp/fizzy-cache",
      sourceName: "app",
      remoteUrl: "https://user:token@example.test/owner/repo.git",
      ref: "main"
    }),
    (error) => {
      assert.equal(error.code, "INVALID_GIT_REMOTE_URL");
      assert.equal(error.details.remote_url, "https://example.test/owner/repo.git");
      assert.equal(JSON.stringify(error).includes("token"), false);
      return true;
    }
  );
  assert.deepEqual(calls, []);
});

test("createGitSourceCacheManager clones, fetches, resolves commit, and returns safe metadata", async () => {
  const calls = [];
  const manager = createGitSourceCacheManager({
    fs: {
      async mkdir() {},
      async access() {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
    },
    exec: async (file, args, options) => {
      calls.push([file, args, options.cwd]);
      if (args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "", exit_code: 0 };
      return { stdout: "", stderr: "", exit_code: 0 };
    },
    now: () => new Date("2026-05-07T18:00:00.000Z")
  });

  const resolved = await manager.resolve({
    sourceCacheRoot: "/tmp/fizzy-cache",
    sourceName: "app",
    remoteUrl: "https://example.test/owner/repo.git",
    ref: "main",
    fetchDepth: 0,
    auth: "auto"
  });

  assert.equal(resolved.source_kind, "git_remote");
  assert.equal(resolved.source_name, "app");
  assert.equal(resolved.source_remote_url, "https://example.test/owner/repo.git");
  assert.equal(resolved.source_display_url, "https://example.test/owner/repo.git");
  assert.equal(resolved.source_ref, "abc123");
  assert.equal(resolved.source_fetched_commit_sha, "abc123");
  assert.equal(resolved.base_ref, "main");
  assert.equal(resolved.source_ref_kind, "resolved_remote_ref");
  assert.equal(resolved.source_fetched_at, "2026-05-07T18:00:00.000Z");
  assert.match(resolved.source_cache_path, /\/tmp\/fizzy-cache\/git-[a-f0-9]{16}$/u);
  assert.deepEqual(calls.map((call) => call[1].slice(0, 3)), [
    ["clone", "https://example.test/owner/repo.git", resolved.source_cache_path],
    ["reset", "--hard"],
    ["clean", "-fd"],
    ["fetch", "--prune", "origin"],
    ["rev-parse", "FETCH_HEAD^{commit}"],
    ["checkout", "--force", "--detach"],
    ["clean", "-fd"]
  ]);
});
