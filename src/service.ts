import { toaster } from "@decky/api";
import api from "./api";
import { SETTINGS } from "./consts";
import { currentUser, listScreenshots, sessionFor, steam } from "./steam";
import { UploadQueue } from "./uploadQueue";
import type { Privacy } from "./uploadQueue";

export class UploadService {
  readonly queue: UploadQueue;
  private handles: { unregister(): void }[] = [];
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private lastScan = 0;
  private lastTick = 0;
  private notifications = true;
  private uploaded = 0;
  private stopped = false;
  private refreshing?: Promise<void>;
  private pauseRequested = false;
  private settingsEpoch = 0;
  error = "";

  constructor() {
    this.queue = new UploadQueue({
      session: () => sessionFor(currentUser()),
      list: listScreenshots,
      get: row => steam.Screenshots.GetLocalScreenshotByHandle(row.strGameID, row.hHandle),
      upload: (row, privacy) => steam.Screenshots.UploadLocalScreenshot(row.strGameID, row.hHandle, privacy),
      load: account => api.loadQueue(account),
      save: state => api.saveQueue(state),
      now: Date.now,
      onChange: () => this.publish(),
      onUploaded: () => {
        this.uploaded += 1;
        void api.increaseCounter({ key: "all" }).catch(error => console.warn("Screenshot counter:", error));
      },
    });
    // Do not upload until the saved enabled/privacy settings have loaded.
    this.queue.options.enabled = false;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private publish(): void {
    if (!this.stopped) for (const listener of this.listeners) listener();
  }

  pauseImmediately(): void {
    this.settingsEpoch += 1;
    this.pauseRequested = true;
    this.queue.options.enabled = false;
    this.publish();
  }

  settingsSaved(): void { this.settingsEpoch += 1; this.pauseRequested = false; }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const epoch = this.settingsEpoch;
    this.refreshing = (async () => {
      const [enabled, privacy, notification] = await Promise.all([
        api.getSetting({ key: SETTINGS.ENABLED, defaults: true }),
        api.getSetting<number>({ key: SETTINGS.PRIVACY_STATE, defaults: 2 }),
        api.getSetting({ key: SETTINGS.NOTIFICATION_ENABLED, defaults: true }),
      ]);
      if (this.stopped || epoch !== this.settingsEpoch) return;
      if (![2, 4, 8, 16].includes(privacy)) throw new Error("Invalid saved visibility; uploads paused.");
      this.queue.options = { enabled: enabled === true && !this.pauseRequested, privacy: privacy as Privacy };
      this.notifications = notification === true;
      this.error = "";
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async kick(scan = false, retry = false): Promise<void> {
    if (this.stopped) return;
    try {
      await this.refresh();
      if (this.stopped) return;
      if (scan) this.lastScan = Date.now();
      await (retry ? this.queue.retryFailed() : this.queue.run(scan));
      if (this.uploaded && !this.stopped) {
        const count = this.uploaded;
        this.uploaded = 0;
        if (this.notifications) toaster.toast({ title: "Screenshots uploaded", body: `${count} screenshot(s) uploaded.`, playSound: false });
      }
    } catch (error) {
      this.queue.options.enabled = false;
      this.error = String(error);
    }
    this.publish();
  }

  start(): void {
    const wake = () => { void this.kick(true); };
    const screenshots = steam.GameSessions.RegisterForScreenshotNotification(event => {
      if (event.strOperation === "written" || event.strOperation === "deleted") wake();
    });
    if (screenshots && typeof screenshots.unregister === "function") this.handles.push(screenshots);
    // User/network native registrations can return void and cannot be cleaned up.
    // Read Steam's live account/connection state on each heartbeat instead.
    window.addEventListener("online", wake);
    window.addEventListener("offline", wake);
    this.handles.push({ unregister: () => {
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wake);
    } });
    this.lastTick = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const scan = now - this.lastScan >= 120_000 || now - this.lastTick > 45_000;
      this.lastTick = now;
      void this.kick(scan);
    }, 15_000);
    wake();
  }

  stop(): void {
    this.stopped = true;
    this.queue.stop();
    clearInterval(this.timer);
    for (const handle of this.handles) {
      try { handle.unregister(); }
      catch (error) { console.warn("Screenshot listener cleanup:", error); }
    }
    this.handles = [];
    this.listeners.clear();
  }
}
