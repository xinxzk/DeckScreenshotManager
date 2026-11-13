import assert from "node:assert/strict";
import test from "node:test";
import { UploadQueue, RECONCILE_DELAY, RETRY_DELAYS, screenshotId } from "../src/uploadQueue.ts";
import type { Privacy, QueueEnvironment, QueueState, Screenshot } from "../src/uploadQueue.ts";

const ACCOUNT = "76561198000000001";
const OTHER = "76561198000000002";
const clone = <T>(x: T): T => structuredClone(x);
function shot(handle = 1): Screenshot {
  return { nAppID: 10, strGameID: "10", hHandle: handle, nCreated: handle,
    strUrl: `screenshots/10/screenshots/${handle}.jpg`, bUploaded: false,
    ugcHandle: "18446744073709551615", publishedFileID: "0", ePrivacy: 2 };
}
function uploaded(row: Screenshot): void {
  Object.assign(row, { bUploaded: true, ugcHandle: `100${row.nCreated}`, publishedFileID: `200${row.nCreated}` });
}

function harness(rows = [shot()]) {
  const session = { account: ACCOUNT, online: true };
  const stores = new Map<string, QueueState>();
  const calls: { account: string; handle: number; privacy: Privacy }[] = [];
  let now = 1_000_000;
  const env: QueueEnvironment = {
    session: () => ({ ...session }),
    now: () => now,
    list: async () => clone(rows),
    get: async row => clone(rows.find(r => r.hHandle === row.hHandle)!),
    load: async account => clone(stores.get(account) ?? { version: 1, account, revision: 0, tasks: [] }),
    save: async state => {
      assert.equal(state.revision, stores.get(state.account)?.revision ?? 0);
      stores.set(state.account, clone({ ...state, revision: state.revision + 1 }));
      return state.revision + 1;
    },
    upload: async (row, privacy) => {
      const intent = stores.get(session.account)!.tasks.find(t => t.path === row.strUrl)!;
      assert.equal(intent.status, "uploading", "intent must be durable before upload");
      calls.push({ account: session.account, handle: row.hHandle, privacy });
      const actual = rows.find(r => r.hHandle === row.hHandle)!;
      uploaded(actual);
      actual.ePrivacy = privacy;
      return true;
    },
    uploadTimeoutMs: 100,
  };
  return { rows, session, stores, calls, env, queue: new UploadQueue(env),
    advance: (ms: number) => { now += ms; } };
}

test("already uploaded screenshots are never queued or uploaded", async () => {
  const h = harness(Array.from({ length: 251 }, (_, i) => shot(i + 1)));
  h.rows.forEach(uploaded);
  await h.queue.run(true);
  await h.queue.run(true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.queue.snapshot().tasks.length, 0);
});

test("offline screenshot survives reload and reacquires a different native handle", async () => {
  const h = harness();
  h.session.online = false;
  await h.queue.run(true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.stores.get(ACCOUNT)!.tasks[0].attempts, 0);
  h.queue.stop();
  h.rows[0].hHandle = 900;
  h.session.online = true;
  const restarted = new UploadQueue(h.env);
  await restarted.run();
  assert.deepEqual(h.calls, [{ account: ACCOUNT, handle: 900, privacy: 2 }]);
  assert.equal(h.stores.get(ACCOUNT)!.tasks.length, 0);
});

test("repeated events and concurrent scans upload each screenshot only once, serially", async () => {
  const h = harness([shot(), shot(2), shot(3)]);
  let active = 0;
  const real = h.env.upload;
  h.env.upload = async (...args) => {
    assert.equal(++active, 1);
    await new Promise(resolve => setTimeout(resolve, 2));
    const result = await real(...args);
    active -= 1;
    return result;
  };
  await Promise.all([h.queue.run(true), h.queue.run(true), h.queue.run(true)]);
  await h.queue.run(true);
  assert.equal(h.calls.length, 3);
});

test("queued visibility is preserved when the default changes", async () => {
  const h = harness();
  h.session.online = false;
  await h.queue.run(true);
  h.queue.options.privacy = 8;
  h.session.online = true;
  await h.queue.run();
  assert.equal(h.calls[0].privacy, 2);
});

test("failure backs off, stops after five attempts, and allows manual retry", async () => {
  const h = harness();
  let attempts = 0;
  h.env.upload = async () => { attempts += 1; return false; };
  await h.queue.run(true);
  await h.queue.run(true);
  assert.equal(attempts, 1);
  for (const delay of RETRY_DELAYS) { h.advance(delay); await h.queue.run(); }
  assert.equal(attempts, 5);
  assert.equal(h.queue.snapshot().tasks[0].status, "failed");
  h.advance(10_000_000);
  await h.queue.run(true);
  assert.equal(attempts, 5);
  await h.queue.retryFailed();
  assert.equal(attempts, 6);
  assert.equal(h.queue.snapshot().tasks[0].attempts, 1);
});

test("upload timeout never starts a second native request while the first is pending", async () => {
  const h = harness([shot(), shot(2)]);
  let resolve!: (value: boolean) => void;
  let calls = 0;
  h.env.uploadTimeoutMs = 5;
  h.env.upload = () => { calls += 1; return new Promise(r => { resolve = r; }); };
  await h.queue.run(true);
  assert.equal(h.queue.snapshot().tasks[0].status, "verifying");
  h.advance(RECONCILE_DELAY * 2);
  await h.queue.run(true);
  assert.equal(calls, 1);
  uploaded(h.rows[0]);
  resolve(true);
  await new Promise(r => setTimeout(r, 0));
  h.env.upload = async row => { calls += 1; uploaded(h.rows.find(r => r.hHandle === row.hHandle)!); return true; };
  await h.queue.run(true);
  assert.equal(calls, 2);
  assert.equal(h.queue.snapshot().tasks.length, 0);
});

test("reload waits before retrying a previously in-flight upload", async () => {
  const h = harness();
  h.session.online = false;
  await h.queue.run(true);
  const task = h.stores.get(ACCOUNT)!.tasks[0];
  Object.assign(task, { status: "uploading", attempts: 1, nextAttemptAt: h.env.now() + RECONCILE_DELAY });
  h.queue.stop();
  h.session.online = true;
  const restarted = new UploadQueue(h.env);
  await restarted.run();
  assert.equal(h.calls.length, 0);
  uploaded(h.rows[0]);
  await restarted.run();
  assert.equal(h.calls.length, 0);
  assert.equal(restarted.snapshot().tasks.length, 0);
});

test("ambiguous success is reconciled before any retry", async () => {
  const h = harness();
  h.env.upload = async () => true;
  await h.queue.run(true);
  assert.equal(h.queue.snapshot().tasks.length, 1);
  uploaded(h.rows[0]);
  await h.queue.run();
  assert.equal(h.queue.snapshot().tasks.length, 0);
});

test("pause during a batch completes the current screenshot and retains the rest", async () => {
  const h = harness([shot(), shot(2)]);
  const upload = h.env.upload;
  h.env.upload = async (...args) => { const result = await upload(...args); h.queue.options.enabled = false; return result; };
  await h.queue.run(true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.queue.snapshot().tasks.length, 1);
});

test("account change during asynchronous lookup prevents an upload", async () => {
  const h = harness();
  const get = h.env.get;
  h.env.get = async row => { const result = await get(row); h.session.account = OTHER; return result; };
  await h.queue.run(true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.queue.snapshot().tasks.length, 0);
  assert.match(h.queue.lastError, /account changed/);
  assert.equal(h.stores.get(ACCOUNT)!.tasks.length, 1);
});

test("failed queue persistence prevents external uploads", async () => {
  const h = harness();
  h.env.save = async () => { throw new Error("disk full"); };
  await h.queue.run(true);
  assert.equal(h.calls.length, 0);
  assert.match(h.queue.lastError, /disk full/);
});

test("a deleted queued screenshot is reported, not uploaded", async () => {
  const h = harness();
  h.session.online = false;
  await h.queue.run(true);
  h.rows.length = 0;
  h.session.online = true;
  await h.queue.run(true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.queue.snapshot().tasks[0].status, "failed");
});

test("handle reuse for a different screenshot stops the batch", async () => {
  const h = harness();
  h.env.get = async () => shot(99);
  await h.queue.run(true);
  assert.equal(h.calls.length, 0);
  assert.match(h.queue.lastError, /handle changed/);
});

test("stable identity includes the account, path and creation time", () => {
  assert.notEqual(screenshotId(ACCOUNT, shot()), screenshotId(OTHER, shot()));
  const other = shot(); other.hHandle = 99;
  assert.equal(screenshotId(ACCOUNT, shot()), screenshotId(ACCOUNT, other));
});

test("reconnecting retries waiting uploads immediately without bypassing verification leases", async () => {
  const h = harness();
  h.env.upload = async () => false;
  await h.queue.run(true);
  h.session.online = false;
  await h.queue.run();
  h.session.online = true;
  let attempts = 0;
  h.env.upload = async () => { attempts += 1; uploaded(h.rows[0]); return true; };
  await h.queue.run();
  assert.equal(attempts, 1);
  assert.equal(h.queue.snapshot().tasks.length, 0);
});

test("an interrupted fifth attempt becomes a recoverable failure after the grace period", async () => {
  const h = harness();
  h.session.online = false;
  await h.queue.run(true);
  Object.assign(h.stores.get(ACCOUNT)!.tasks[0], {
    status: "uploading", attempts: 5, updatedAt: h.env.now(), nextAttemptAt: h.env.now() + RECONCILE_DELAY,
  });
  h.queue.stop();
  const restarted = new UploadQueue(h.env);
  h.session.online = true;
  await restarted.run();
  assert.equal(h.calls.length, 0);
  h.advance(RECONCILE_DELAY);
  await restarted.run();
  assert.equal(h.calls.length, 0);
  assert.equal(restarted.snapshot().tasks[0].status, "failed");
  await restarted.retryFailed();
  assert.equal(h.calls.length, 1);
  assert.equal(restarted.snapshot().tasks.length, 0);
});
