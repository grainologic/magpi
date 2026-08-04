import assert from "node:assert/strict";
import { test } from "node:test";
import { inFlight, share } from "../src/inflight.js";

/** A promise plus the handles to settle it, so a test can hold work open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("concurrent callers on one key run the work once", async () => {
  const d = deferred<string>();
  let runs = 0;
  const work = () => {
    runs++;
    return d.promise;
  };

  const a = share("u", work);
  const b = share("u", work);
  assert.equal(runs, 1, "the follower joins instead of starting its own");
  assert.equal(inFlight(), 1);

  d.resolve("content");
  assert.deepEqual(await Promise.all([a, b]), ["content", "content"], "both callers get the result");
  assert.equal(inFlight(), 0, "the key is released once settled");
});

test("different keys stay independent and a failure does not stick", async () => {
  let runs = 0;
  const boom = () => {
    runs++;
    return Promise.reject(new Error("network down"));
  };

  await assert.rejects(share("x", boom), /network down/);
  assert.equal(inFlight(), 0, "a rejected call releases its key");

  // A later caller on the same key must be able to try again.
  await assert.rejects(share("x", boom), /network down/);
  assert.equal(runs, 2, "the retry actually ran");

  const ok = await Promise.all([share("y", async () => "y"), share("z", async () => "z")]);
  assert.deepEqual(ok, ["y", "z"], "separate keys do not collapse");
});
