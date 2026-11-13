export type Privacy = 2 | 4 | 8 | 16;

export interface Screenshot {
  nAppID: number;
  strGameID: string;
  hHandle: number;
  nCreated: number;
  strUrl: string;
  bUploaded: boolean;
  ugcHandle: string;
  publishedFileID: string;
  ePrivacy: number;
}

export interface Task {
  id: string;
  gameId: string;
  path: string;
  created: number;
  privacy: Privacy;
  status: "pending" | "uploading" | "waiting" | "verifying" | "failed";
  attempts: number;
  nextAttemptAt: number;
  updatedAt: number;
  error: string;
}

export interface QueueState {
  version: 1;
  account: string;
  revision: number;
  tasks: Task[];
}

export interface Session { account: string; online: boolean }
export interface QueueOptions { enabled: boolean; privacy: Privacy }
export interface QueueEnvironment {
  session(): Session | undefined;
  list(): Promise<Screenshot[]>;
  get(row: Screenshot): Promise<Screenshot>;
  upload(row: Screenshot, privacy: Privacy): Promise<boolean>;
  load(account: string): Promise<QueueState>;
  save(state: QueueState): Promise<number>;
  now(): number;
  onChange?(): void;
  onUploaded?(): void;
  uploadTimeoutMs?: number;
}

export const RETRY_DELAYS = [30_000, 120_000, 600_000, 1_800_000];
export const RECONCILE_DELAY = 300_000;
const MAX_ATTEMPTS = 5;
const TIMEOUT = Symbol("upload still running");

export function screenshotId(account: string, row: Screenshot): string {
  // Native hHandle is session-local. Never persist it or derive it from screenshots.vdf.
  return JSON.stringify([account, row.strGameID, row.strUrl, row.nCreated]);
}

export function confirmed(row: Screenshot): boolean {
  return row.bUploaded === true && !!row.publishedFileID && row.publishedFileID !== "0"
    && !!row.ugcHandle && !["0", "18446744073709551615"].includes(row.ugcHandle);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export class UploadQueue {
  private env: QueueEnvironment;
  private state?: QueueState;
  private active?: Promise<void>;
  private disposed = false;
  private scanRequested = true;
  private retryRequested = false;
  private outstanding?: { settled: boolean };
  private previousSession?: Session;
  private reconnected = false;
  options: QueueOptions = { enabled: true, privacy: 2 };
  lastError = "";
  completed = 0;

  constructor(env: QueueEnvironment) { this.env = env; }

  snapshot() {
    const session = this.env.session();
    const tasks = this.state?.account === session?.account ? this.state?.tasks ?? [] : [];
    return { account: session?.account, online: session?.online ?? false,
      enabled: this.options.enabled, busy: !!this.active, completed: this.completed,
      error: this.lastError, tasks: tasks.map(task => ({ ...task })) };
  }

  stop(): void { this.disposed = true; }

  retryFailed(): Promise<void> {
    this.retryRequested = true;
    return this.run(true);
  }

  run(scan = false): Promise<void> {
    const session = this.env.session();
    if (session?.online && this.previousSession?.account === session.account && !this.previousSession.online) {
      this.reconnected = true;
      scan = true;
    }
    this.previousSession = session;
    this.scanRequested ||= scan;
    if (this.disposed) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.cycle().catch(error => {
      // Failed storage writes stop processing; reload the authoritative revision next time.
      this.lastError = errorText(error);
      this.state = undefined;
    }).finally(() => { this.active = undefined; this.changed(); });
    this.changed();
    return this.active;
  }

  private changed(): void { if (!this.disposed) this.env.onChange?.(); }

  private checkAccount(account: string): void {
    if (this.disposed || this.env.session()?.account !== account) {
      throw new Error("Steam account changed or plugin unloaded; uploads paused.");
    }
  }

  private async save(state: QueueState): Promise<void> {
    this.checkAccount(state.account);
    state.revision = await this.env.save({ ...state, tasks: state.tasks.map(t => ({ ...t })) });
    this.checkAccount(state.account);
    this.changed();
  }

  private async finish(state: QueueState, task: Task): Promise<void> {
    state.tasks = state.tasks.filter(t => t.id !== task.id);
    await this.save(state);
    this.completed += 1;
    this.env.onUploaded?.();
  }

  private async cycle(): Promise<void> {
    const session = this.env.session();
    if (!session) return;
    const account = session.account;
    if (!this.state || this.state.account !== account) {
      if (this.state?.account !== account) this.completed = 0;
      const state = await this.env.load(account);
      this.checkAccount(account);
      if (state.account !== account || state.version !== 1) throw new Error("Invalid queue account or version.");
      for (const task of state.tasks) {
        if (task.status === "uploading") {
          task.status = "verifying";
          task.nextAttemptAt = Math.max(task.nextAttemptAt, task.updatedAt + RECONCILE_DELAY);
        }
      }
      this.state = state;
      this.scanRequested = true;
    }
    const state = this.state;
    if (!this.options.enabled) return;
    if (!this.scanRequested && !state.tasks.length && !this.retryRequested) return;
    const discover = this.scanRequested;
    this.scanRequested = false;
    const rows = await this.env.list();
    this.checkAccount(account);
    const byId = new Map(rows.map(row => [screenshotId(account, row), row]));
    let modified = false;
    if (this.reconnected) {
      this.reconnected = false;
      for (const task of state.tasks) {
        if (task.status === "waiting") {
          task.nextAttemptAt = 0;
          modified = true;
        }
      }
    }
    for (const task of [...state.tasks]) {
      const row = byId.get(task.id);
      if (!row) {
        if (task.status !== "failed" || task.error !== "Local screenshot was removed.") {
          task.status = "failed";
          task.error = "Local screenshot was removed.";
          modified = true;
        }
      } else if (confirmed(row)) {
        await this.finish(state, task);
      }
    }
    if (discover) {
      const known = new Set(state.tasks.map(t => t.id));
      for (const row of rows) {
        const id = screenshotId(account, row);
        if (row.bUploaded || known.has(id)) continue;
        state.tasks.push({ id, gameId: row.strGameID, path: row.strUrl,
          created: row.nCreated, privacy: this.options.privacy, status: "pending",
          attempts: 0, nextAttemptAt: 0, updatedAt: this.env.now(), error: "" });
        known.add(id);
        modified = true;
      }
    }
    if (this.retryRequested) {
      this.retryRequested = false;
      for (const task of state.tasks) {
        if (task.status === "failed" && byId.has(task.id)) {
          Object.assign(task, { status: "pending", attempts: 0, nextAttemptAt: 0, error: "" });
          modified = true;
        }
      }
    }
    if (modified) await this.save(state);
    this.lastError = "";
    this.changed();
    if (this.outstanding && !this.outstanding.settled) return;
    this.outstanding = undefined;
    for (const task of [...state.tasks]) {
      this.checkAccount(account);
      if (!this.options.enabled || !this.env.session()?.online) break;
      if (task.status === "failed" || task.nextAttemptAt > this.env.now()) continue;
      const row = byId.get(task.id);
      if (!row) continue;
      const latest = await this.env.get(row);
      this.checkAccount(account);
      if (screenshotId(account, latest) !== task.id) throw new Error("Screenshot handle changed; rescan required.");
      if (confirmed(latest)) { await this.finish(state, task); continue; }
      if (latest.bUploaded) {
        task.status = "failed";
        task.error = "Steam reports uploaded, but cloud identifiers are missing. Check in Steam before retrying.";
        await this.save(state);
        continue;
      }
      if (task.attempts >= MAX_ATTEMPTS) {
        task.status = "failed";
        task.error = "Upload attempts exhausted after verification. Retry manually to continue.";
        await this.save(state);
        continue;
      }
      if (!this.options.enabled || !this.env.session()?.online) break;
      task.status = "uploading";
      task.updatedAt = this.env.now();
      task.nextAttemptAt = task.updatedAt + RECONCILE_DELAY;
      task.attempts += 1;
      task.error = "";
      await this.save(state); // Persist intent before the external operation.
      if (!this.options.enabled || !this.env.session()?.online) {
        task.status = "pending";
        task.attempts -= 1;
        task.nextAttemptAt = 0;
        await this.save(state);
        break;
      }
      const inFlight = { settled: false };
      this.outstanding = inFlight;
      const operation = Promise.resolve().then(() => {
        this.checkAccount(account);
        return this.env.upload(latest, task.privacy);
      }).then(result => ({ result, error: "" }), error => ({ result: false, error: errorText(error) }))
        .finally(() => { inFlight.settled = true; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        operation,
        new Promise<typeof TIMEOUT>(resolve => {
          timer = setTimeout(() => resolve(TIMEOUT), this.env.uploadTimeoutMs ?? 90_000);
        }),
      ]);
      clearTimeout(timer);
      this.checkAccount(account);
      if (result === TIMEOUT) {
        task.status = "verifying";
        task.error = "Waiting for Steam to finish; checking status before any retry.";
        await this.save(state);
        return; // Do not start another upload while the original native request is alive.
      }
      this.outstanding = undefined;
      const after = await this.env.get(latest);
      this.checkAccount(account);
      if (screenshotId(account, after) !== task.id) throw new Error("Screenshot identity changed after upload.");
      if (confirmed(after)) {
        await this.finish(state, task);
      } else {
        task.status = task.attempts >= MAX_ATTEMPTS ? "failed" : "waiting";
        task.error = result.error || (result.result
          ? "Steam accepted the upload but has not confirmed cloud identifiers yet."
          : "Steam could not upload this screenshot. Check your connection and cloud storage.");
        task.nextAttemptAt = this.env.now() + RETRY_DELAYS[Math.min(task.attempts - 1, RETRY_DELAYS.length - 1)];
        task.updatedAt = this.env.now();
        await this.save(state);
      }
    }
  }
}
