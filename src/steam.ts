import type { Screenshot } from "./uploadQueue";

export interface CurrentUser { strSteamID: string; bIsOfflineMode: boolean }
interface Subscription { unregister(): void }

interface SteamAPI {
    Screenshots: {
      GetAllAppsLocalScreenshotsCount(): Promise<number>;
      GetAllAppsLocalScreenshotsRange(start: number, end: number): Promise<Screenshot[]>;
      GetLocalScreenshotByHandle(game: string, handle: number): Promise<Screenshot>;
      UploadLocalScreenshot(game: string, handle: number, privacy: number): Promise<boolean>;
    };
    GameSessions: {
      RegisterForScreenshotNotification(fn: (event: { strOperation: string }) => void): Subscription;
    };
}
interface SteamGlobals {
  SteamClient: SteamAPI;
  App?: {
    m_CurrentUser?: CurrentUser;
    m_cm?: { BIsConnected?(): boolean };
  };
}
const globals = globalThis as unknown as SteamGlobals;
export const steam = globals.SteamClient;
export function currentUser(): CurrentUser | undefined { return globals.App?.m_CurrentUser; }

export async function listScreenshots(): Promise<Screenshot[]> {
  const api = steam.Screenshots;
  if (!api.GetAllAppsLocalScreenshotsCount || !api.GetAllAppsLocalScreenshotsRange) {
    throw new Error("This Steam version does not provide the screenshot listing API.");
  }
  const count = await api.GetAllAppsLocalScreenshotsCount();
  const rows: Screenshot[] = [];
  for (let start = 0; start < count; start += 100) {
    rows.push(...await api.GetAllAppsLocalScreenshotsRange(start, Math.min(count - 1, start + 99)));
  }
  return rows;
}

export function sessionFor(user?: CurrentUser) {
  if (!user || !/^\d{17}$/.test(user.strSteamID)) return undefined;
  const connection = globals.App?.m_cm;
  const connected = typeof connection?.BIsConnected === "function"
    ? connection.BIsConnected() : navigator.onLine;
  return { account: user.strSteamID, online: !user.bIsOfflineMode && connected };
}
