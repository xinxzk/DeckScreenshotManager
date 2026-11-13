import assert from "node:assert/strict";
import test from "node:test";

const globals = globalThis as any;
const requests: number[][] = [];
globals.SteamClient = { Screenshots: {
  GetAllAppsLocalScreenshotsCount: async () => 251,
  GetAllAppsLocalScreenshotsRange: async (start: number, end: number) => {
    requests.push([start, end]);
    return Array.from({ length: end - start + 1 }, (_, i) => ({ hHandle: start + i }));
  },
} };
globals.App = { m_cm: { BIsConnected: () => true } };
const { listScreenshots, sessionFor } = await import("../src/steam.ts");

test("Steam adapter paginates with inclusive endpoints", async () => {
  const rows = await listScreenshots();
  assert.equal(rows.length, 251);
  assert.deepEqual(requests, [[0, 99], [100, 199], [200, 250]]);
});

test("offline mode and a disconnected Steam session pause uploads", () => {
  const user = { strSteamID: "76561198000000001", bIsOfflineMode: false };
  assert.equal(sessionFor(user)?.online, true);
  assert.equal(sessionFor({ ...user, bIsOfflineMode: true })?.online, false);
  globals.App.m_cm.BIsConnected = () => false;
  assert.equal(sessionFor(user)?.online, false);
  assert.equal(sessionFor(undefined), undefined);
  assert.equal(sessionFor({ ...user, strSteamID: "invalid" }), undefined);
});
