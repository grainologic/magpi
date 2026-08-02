import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as cache from "../src/cache.js";

test("canonicalize collapses URL variants into one key", () => {
  const canon = (s: string) => cache.canonicalize(new URL(s));
  const base = canon("https://example.com/docs/page");
  assert.equal(canon("https://EXAMPLE.com/docs/page#section"), base, "fragment + host case");
  assert.equal(canon("https://example.com/docs/page/"), base, "trailing slash");
  assert.equal(canon("https://example.com/docs/page?utm_source=x&fbclid=y"), base, "tracking params");
  assert.equal(
    canon("https://example.com/search?b=2&a=1"),
    canon("https://example.com/search?a=1&b=2"),
    "query order",
  );
  assert.notEqual(canon("https://example.com/search?a=1"), canon("https://example.com/search?a=2"), "real params kept");
});

test("entryDir paths are host-grouped and human-readable", () => {
  const dir = cache.entryDir("/root", "https://github.com/user/repo", "light");
  assert.match(dir.replace(/\\/g, "/"), /\/root\/github\.com\/user-repo-[0-9a-f]{8}$/);
  const full = cache.entryDir("/root", "https://github.com/user/repo", "full");
  assert.match(full.replace(/\\/g, "/"), /user-repo-full-[0-9a-f]{8}$/);
  assert.notEqual(dir, full, "mode is part of the key");
});

test("lookupAny unions caches, first root wins", () => {
  const rootA = mkdtempSync(join(tmpdir(), "magpi-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "magpi-b-"));
  const url = "https://example.com/page";
  cache.store(rootB, url, "light", { handler: "webpage", kind: "article", content: "from B", hasTree: false });

  const hit = cache.lookupAny([rootA, rootB], url, "light", 24);
  assert.ok(hit, "entry in second root is found");
  assert.equal(readFileSync(hit!.contentPath, "utf8"), "from B");

  cache.store(rootA, url, "light", { handler: "webpage", kind: "article", content: "from A", hasTree: false });
  const preferred = cache.lookupAny([rootA, rootB], url, "light", 24);
  assert.equal(readFileSync(preferred!.contentPath, "utf8"), "from A", "write-scope root takes precedence");

  assert.equal(cache.lookupAny([rootA, rootB], "https://example.com/other", "light", 24), undefined);
});

test("cache roundtrip, timestamps, ttl expiry, and prune", () => {
  const root = mkdtempSync(join(tmpdir(), "magpi-test-"));
  const url = "https://example.com/x";
  const stored = cache.store(root, url, "light", {
    handler: "webpage",
    kind: "article",
    content: "hello world",
    hasTree: false,
  });
  assert.ok(Date.parse(stored.meta.fetchedAt) > 0, "timestamp recorded");

  const hit = cache.lookup(root, url, "light", 24);
  assert.ok(hit, "fresh entry is a hit");
  assert.equal(readFileSync(hit!.contentPath, "utf8"), "hello world");
  assert.equal(cache.lookup(root, url, "full", 24), undefined, "mode is part of the key");

  // Age the entry past the ttl and confirm it misses
  const metaPath = join(stored.dir, "meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  meta.fetchedAt = new Date(Date.now() - 48 * 3_600_000).toISOString();
  writeFileSync(metaPath, JSON.stringify(meta));
  assert.equal(cache.lookup(root, url, "light", 24), undefined, "stale entry expires");

  assert.equal(cache.stats(root).entries, 1);
  assert.equal(cache.prune(root, 24), 1, "prune removes the aged entry");
  assert.equal(cache.stats(root).entries, 0);

  cache.store(root, url, "light", { handler: "webpage", kind: "article", content: "x", hasTree: false });
  assert.equal(cache.prune(root, 24), 0, "prune keeps fresh entries");
  cache.clear(root);
  assert.equal(cache.stats(root).entries, 0);
});
