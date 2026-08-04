// Live network selfcheck: the promoted smoke test. Hits real free endpoints,
// so individual sources may be rate-limited; each check tolerates its own
// flakiness where that's expected, and the whole file skips when offline.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FetchContext } from "../src/handlers/handler.js";
import { resolveHandler } from "../src/handlers/registry.js";
import { webSearch } from "../src/search.js";

const online = await fetch("https://example.com/", { signal: AbortSignal.timeout(5000) })
  .then((r) => r.ok)
  .catch(() => false);

function ctx(): FetchContext {
  return {
    mode: "light",
    entryDir: mkdtempSync(join(tmpdir(), "magpi-selfcheck-")),
    exec: async () => ({ stdout: "", stderr: "exec not needed in light mode", code: 1 }),
  };
}

async function fetchVia(urlStr: string) {
  const url = new URL(urlStr);
  return resolveHandler(url).fetch(url, ctx());
}

test("wikipedia handler returns plaintext article", { skip: !online }, async () => {
  const r = await fetchVia("https://en.wikipedia.org/wiki/Zebra");
  assert.equal(r.kind, "article");
  assert.match(r.content, /striped/i);
  assert.doesNotMatch(r.content, /<html/i);
});

test("npm registry handler returns metadata + readme", { skip: !online }, async () => {
  const r = await fetchVia("https://www.npmjs.com/package/lodash");
  assert.equal(r.kind, "package-info");
  assert.match(r.content, /lodash \(npm\)/);
  assert.match(r.content, /version:/);
});

test("pi.dev package pages resolve through npm", { skip: !online }, async () => {
  const r = await fetchVia("https://pi.dev/packages/pi-magpi");
  assert.equal(r.kind, "package-info");
  assert.match(r.content, /pi-magpi \(npm\)/);
});

test("github handler returns readme with metadata header", { skip: !online }, async () => {
  const r = await fetchVia("https://github.com/sindresorhus/p-retry");
  assert.equal(r.kind, "readme");
  assert.match(r.content, /p-retry/);
});

test("arxiv handler answers a versioned pdf url", { skip: !online }, async () => {
  // Whichever way it gets there: the export api, or the abstract page when
  // export.arxiv.org is having one of its days.
  const r = await fetchVia("https://arxiv.org/pdf/1706.03762v7.pdf");
  assert.ok(r.kind === "paper" || r.kind === "article", `unexpected kind ${r.kind}`);
  assert.match(r.content, /Attention Is All You Need/i);
  assert.match(r.content, /transduction|Transformer/i, "the abstract came through");
});

test("default handler extracts a generic webpage", { skip: !online }, async () => {
  const r = await fetchVia("https://example.com/");
  assert.equal(r.kind, "article");
  assert.match(r.content, /Example Domain/);
});

test("pdf urls are extracted as text", { skip: !online }, async () => {
  const r = await fetchVia("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf");
  assert.equal(r.kind, "pdf");
  assert.match(r.content, /dummy pdf/i);
});

test("at least one search source returns results", { skip: !online }, async () => {
  // Rate limits are expected and fine; auto falls through ddg -> wikipedia -> hn.
  const { results, errors } = await webSearch("rust programming language", "auto");
  assert.ok(results.length > 0, `all sources failed: ${errors.join("; ")}`);
  assert.match(results[0].url, /^https?:\/\//);
});
