import assert from "node:assert/strict";
import { test } from "node:test";
import { elideFetchPreviews } from "../src/prune.js";

const fetchResult = (path: string, text = "big preview ".repeat(100)) => ({
  role: "toolResult",
  toolName: "magpi_fetch",
  content: [{ type: "text", text }],
  details: { contentPath: path },
});

test("elideFetchPreviews keeps recent previews, elides old ones", () => {
  const messages = [
    { role: "user", content: "hi" },
    fetchResult("/cache/a.md"),
    fetchResult("/cache/b.md"),
    { role: "assistant", content: "ok" },
    fetchResult("/cache/c.md"),
    fetchResult("/cache/d.md"),
  ];
  elideFetchPreviews(messages as never[], 2, 0);

  const texts = messages
    .filter((m: any) => m.role === "toolResult")
    .map((m: any) => m.content[0].text as string);
  assert.match(texts[0], /preview elided.*\/cache\/a\.md/);
  assert.match(texts[1], /preview elided.*\/cache\/b\.md/);
  assert.match(texts[2], /big preview/, "recent previews untouched");
  assert.match(texts[3], /big preview/);
  assert.equal((messages[0] as any).content, "hi", "non-fetch messages untouched");
});

test("elideFetchPreviews ignores other tools and pathless results", () => {
  const other = { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file body" }] };
  const pathless = { role: "toolResult", toolName: "magpi_fetch", content: [{ type: "text", text: "err" }], details: {} };
  const messages = [other, pathless, fetchResult("/cache/x.md"), fetchResult("/cache/y.md"), fetchResult("/cache/z.md")];
  elideFetchPreviews(messages as never[], 2, 0);
  assert.equal((other.content[0] as any).text, "file body");
  assert.equal((pathless.content[0] as any).text, "err");
  assert.match((messages[2] as any).content[0].text, /elided/);
});

test("elision is batched by byte threshold and committed paths stay elided", () => {
  const big = "x".repeat(600);
  const messages = [fetchResult("/h/1.md", big), fetchResult("/h/2.md", big), fetchResult("/h/3.md", big)];

  // one eligible preview, 600 chars, under the 1000 threshold: untouched
  elideFetchPreviews(messages as never[], 2, 1000);
  assert.match((messages[0] as any).content[0].text, /^x+$/, "below threshold, no elision");

  // two eligible previews, 1200 chars, over the threshold: both elided at once
  messages.push(fetchResult("/h/4.md", big));
  elideFetchPreviews(messages as never[], 2, 1000);
  assert.match((messages[0] as any).content[0].text, /elided/);
  assert.match((messages[1] as any).content[0].text, /elided/);

  // next fetch makes /h/3.md eligible; 600 fresh chars is under the threshold
  // again, so it survives while the committed ones stay elided
  messages.push(fetchResult("/h/5.md", big));
  elideFetchPreviews(messages as never[], 2, 1000);
  assert.match((messages[0] as any).content[0].text, /elided/, "committed stays elided");
  assert.match((messages[2] as any).content[0].text, /^x+$/, "fresh preview under threshold kept");
});
