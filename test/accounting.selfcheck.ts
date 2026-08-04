import assert from "node:assert/strict";
import { test } from "node:test";
import * as accounting from "../src/accounting.js";
import { elideFetchPreviews } from "../src/prune.js";

test("counters separate network, cache, and stale service", () => {
  accounting.reset();
  accounting.recordFetch(false, false);
  accounting.recordFetch(false, false);
  accounting.recordFetch(true, false);
  accounting.recordFetch(true, true);

  const c = accounting.snapshot();
  assert.equal(c.fetches, 2, "network fetches");
  assert.equal(c.hits, 1, "fresh cache hits");
  assert.equal(c.stale, 1, "stale service is not counted as a hit");
});

test("withheld and elided chars estimate tokens kept out of context", () => {
  accounting.reset();
  accounting.recordWithheld(4000);
  accounting.recordElided(4000);
  accounting.recordWithheld(-5); // a preview longer than its source cannot happen
  assert.equal(accounting.snapshot().withheldChars, 4000, "negative deltas are ignored");
  assert.equal(accounting.tokensSaved(), 2000, "8000 chars at 4 chars per token");

  accounting.reset();
  assert.equal(accounting.tokensSaved(), 0, "reset clears the session");
});

test("elision reports each preview once, not on every later call", () => {
  accounting.reset();
  const big = "x".repeat(30_000);
  const messages = [
    { role: "toolResult", toolName: "magpi_fetch", content: big, details: { contentPath: "/c/a.md" } },
    { role: "toolResult", toolName: "magpi_fetch", content: "b", details: { contentPath: "/c/b.md" } },
    { role: "toolResult", toolName: "magpi_fetch", content: "c", details: { contentPath: "/c/c.md" } },
  ];

  elideFetchPreviews(structuredClone(messages));
  const first = accounting.snapshot().elidedChars;
  assert.equal(first, 30_000, "the committed preview is counted");

  // The context event hands over a fresh copy every call; re-eliding is not a new saving.
  elideFetchPreviews(structuredClone(messages));
  assert.equal(accounting.snapshot().elidedChars, first, "no double counting");
});

test("summary reads as one line and names both service paths", () => {
  accounting.reset();
  accounting.recordFetch(false, false);
  accounting.recordFetch(true, false);
  accounting.recordWithheld(40_000);
  const line = accounting.summary();
  assert.equal(line.includes("\n"), false, "status prints it as a single row");
  assert.match(line, /1 fetched, 1 from cache/);
  assert.match(line, /~10,000 tokens/);
});
