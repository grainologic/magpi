import assert from "node:assert/strict";
import { test } from "node:test";
import { fallbackText, htmlToMarkdown } from "../src/html.js";

const P = "This paragraph exists to give Readability enough content to consider the article real. ".repeat(3);

test("htmlToMarkdown extracts the article as markdown", () => {
  const html = `<!doctype html><html><head><title>My Page</title></head><body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <article><h1>The Real Heading</h1><p>${P}</p><p>${P}</p><p>Key fact: zebras.</p></article>
    <footer>copyright</footer></body></html>`;
  const page = htmlToMarkdown(html);
  assert.match(page.markdown, /The Real Heading|My Page/);
  assert.match(page.markdown, /zebras/);
  assert.doesNotMatch(page.markdown, /<article>/);
});

test("fallbackText strips tags, scripts and entities", () => {
  const out = fallbackText(`<html><script>var x=1;</script><body><p>a &amp; b</p></body></html>`);
  assert.equal(out.includes("var x"), false);
  assert.match(out, /a & b/);
});
