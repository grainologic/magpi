import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDdgLite } from "../src/search.js";

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
