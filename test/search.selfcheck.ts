import assert from "node:assert/strict";
import { test } from "node:test";
import { parseContext7, parseDdgLite } from "../src/search.js";

test("parseDdgLite parses redirect links and snippets", () => {
  const html = `<html><body><table>
    <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc">Example Docs</a></td></tr>
    <tr><td class="result-snippet">The official docs for Example.</td></tr>
    <tr><td><a rel="nofollow" href="https://direct.example.org/page">Direct Result</a></td></tr>
    <tr><td class="result-snippet">A directly linked page.</td></tr>
  </table></body></html>`;
  const results = parseDdgLite(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/docs");
  assert.equal(results[0].title, "Example Docs");
  assert.equal(results[0].snippet, "The official docs for Example.");
  assert.equal(results[1].url, "https://direct.example.org/page");
});

test("parseContext7 maps library hits onto the plaintext docs api", () => {
  const payload = {
    results: [
      {
        id: "/vercel/next.js",
        title: "Next.js",
        description: "The React framework",
        totalSnippets: 4210,
        trustScore: 10,
      },
      { id: "/empty/docs", title: "Empty", totalSnippets: 0 },
      { title: "No id at all", totalSnippets: 9 },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `/lib/${i}`, title: `lib${i}`, totalSnippets: 1 })),
    ],
  };

  const results = parseContext7(payload);
  assert.equal(results.length, 8, "capped like the other sources");
  assert.equal(results[0].url, "https://context7.com/api/v1/vercel/next.js?type=txt", "fetchable plaintext url");
  assert.equal(results[0].source, "context7");
  assert.match(results[0].snippet!, /The React framework \| 4210 snippets \| trust 10/);
  assert.ok(
    !results.some((r) => /empty|No id/i.test(r.title)),
    "entries with no snippets or no id are dropped",
  );

  assert.deepEqual(parseContext7({}), [], "a payload with no results is not an error");
  assert.deepEqual(parseContext7(null), [], "neither is a broken response");
});
