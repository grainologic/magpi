import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicTarget, isPrivateIp } from "../src/handlers/handler.js";
import { REGISTRIES } from "../src/handlers/registries/index.js";
import { registerHandler, resolveHandler } from "../src/handlers/registry.js";

test("handler routing picks the right handler", () => {
  const cases: Array<[string, string]> = [
    ["https://github.com/user/repo", "github"],
    ["https://raw.githubusercontent.com/u/r/main/file.ts", "github"],
    ["https://gitlab.com/group/proj", "gitlab"],
    ["https://en.wikipedia.org/wiki/Zebra", "wikipedia"],
    ["https://www.wikidata.org/wiki/Q42", "wikipedia"],
    ["https://www.npmjs.com/package/@scope/pkg", "packages"],
    ["https://pypi.org/project/requests/", "packages"],
    ["https://crates.io/crates/serde", "packages"],
    ["https://pkg.go.dev/golang.org/x/mod", "packages"],
    ["https://rubygems.org/gems/rails", "packages"],
    ["https://packagist.org/packages/laravel/framework", "packages"],
    ["https://hex.pm/packages/phoenix", "packages"],
    ["https://mvnrepository.com/artifact/com.google.guava/guava", "packages"],
    ["https://stackoverflow.com/questions/11227809/why-is-processing-sorted", "stackexchange"],
    ["https://unix.stackexchange.com/questions/121/", "stackexchange"],
    ["https://www.reddit.com/r/rust/comments/abc123/some_thread/", "reddit"],
    ["https://www.reddit.com/r/rust/", "webpage"], // subreddit page, not a thread
    ["https://news.ycombinator.com/item?id=1", "hackernews"],
    ["https://news.ycombinator.com/newest", "webpage"], // HN front pages are ordinary pages
    ["https://arxiv.org/abs/1706.03762", "arxiv"],
    ["https://arxiv.org/pdf/1706.03762", "arxiv"],
    ["https://example.com/some/page", "webpage"],
    ["https://github.io", "webpage"], // not github.com
  ];
  for (const [url, expected] of cases) {
    assert.equal(resolveHandler(new URL(url)).name, expected, url);
  }
});

test("registry matchers extract package identifiers", () => {
  const byName = Object.fromEntries(REGISTRIES.map((r) => [r.name, r]));
  assert.equal(byName["npm"].match(new URL("https://www.npmjs.com/package/@scope/pkg")), "@scope/pkg");
  assert.equal(byName["npm"].match(new URL("https://www.npmjs.com/package/lodash")), "lodash");
  assert.equal(byName["pypi"].match(new URL("https://pypi.org/project/requests/")), "requests");
  assert.equal(byName["maven"].match(new URL("https://mvnrepository.com/artifact/g.id/artifact/1.2")), "g.id:artifact:1.2");
});

test("ssrf guard blocks private targets and bad schemes", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.ok(isPrivateIp(ip), ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) {
    assert.ok(!isPrivateIp(ip), ip);
  }
  await assert.rejects(assertPublicTarget(new URL("http://127.0.0.1/admin")), /private/);
  await assert.rejects(assertPublicTarget(new URL("http://169.254.169.254/latest/meta-data/")), /private/);
  await assert.rejects(assertPublicTarget(new URL("http://localhost:3000/")), /loopback/);
  await assert.rejects(assertPublicTarget(new URL("ftp://example.com/x")), /scheme/);
  await assert.doesNotReject(assertPublicTarget(new URL("https://8.8.8.8/")));
});

test("registerHandler validates shape and takes priority", () => {
  assert.throws(() => registerHandler({ name: "bad" } as never));
  registerHandler({
    name: "my-blog",
    description: "test handler",
    match: (url) => url.hostname === "example.com",
    fetch: async () => ({ kind: "article", content: "custom" }),
  });
  assert.equal(resolveHandler(new URL("https://example.com/post")).name, "my-blog");
  assert.equal(resolveHandler(new URL("https://other.com/")).name, "webpage");
});
