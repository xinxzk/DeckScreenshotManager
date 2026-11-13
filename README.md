# Screenshot Uploader — automatic offline catch-up

A personal fork of [CodeHz's ScreenshotUploader](https://github.com/codehz/DeckScreenshotManager), for Decky Loader on Steam Deck. Screenshots are uploaded through the logged-in Steam client's native screenshot API.

## What's new in 0.1.0

- New screenshots enter a durable queue before upload. Offline screenshots are retained for later.
- Scans on startup, screenshot events, browser network events, and every two minutes discover missed screenshots. A 15-second heartbeat checks the live Steam account/connection state, handles retries, and detects long timer gaps after suspend. Native user/network callbacks that cannot be unsubscribed are deliberately avoided.
- Pending uploads survive plugin reloads and Steam restarts. Queue files are separated by Steam account.
- Only one native upload runs at a time. Every upload rechecks the current account and Steam's uploaded status and obtains the current native screenshot handle.
- Transient failures back off for 30 seconds, 2 minutes, 10 minutes, and 30 minutes. After five unsuccessful attempts a task waits for manual retry. Known offline time does not consume attempts. Reconnection makes waiting retries eligible immediately.
- Upload timeouts enter a verification state. The worker will not issue another upload while that native request is still pending. After plugin restart, previously in-flight tasks receive a five-minute grace period while their status is checked.
- Chinese progress panel with queue counts, paginated task/failure details, pause, scan-and-upload, and retry-failed controls. Notifications summarize completed work.
- Private visibility by default; each task retains its visibility at enqueue time. Existing uploaded screenshots are skipped and their visibility is not changed.
- Fixes the upstream Decky RPC argument forwarding and adds a direct Rollup build dependency.

Enabling automatic uploads also catches up **all local unuploaded screenshots for the current account**. Turn it off to pause discovery and new uploads. An upload that has already started is allowed to finish. Steam and Decky must be running; powered-off time is handled on the next startup.

## Build and check

Requires Node.js 22.18+ (TypeScript stripping), Corepack/pnpm, and Python 3.10+ on Linux.

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
pnpm package
```

`out/ScreenshotUploader-0.1.0.zip` is the Decky installation ZIP. The adjacent `.sha256` file records its checksum. CI runs the same checks and uploads the ZIP as an Actions artifact. The package contains code and documentation only; no screenshots, local settings, account data, or queue files are included.

## Install and roll back

1. Back up the currently installed `DeckScreenshotManager` plugin directory and its Decky settings directory.
2. In Decky developer settings, use **Install Plugin from ZIP File** with the built ZIP. It replaces the original `ScreenshotUploader`; do not run both versions together.
3. Open the plugin panel, confirm the desired visibility, and inspect queue status. Existing enabled/notification/privacy settings are retained. With no saved preference, visibility is private.
4. To roll back, restore the previous plugin directory and reload the plugin. Keep the settings backup. This version never edits `screenshots.vdf` or deletes local screenshot files.

The fork retains the original plugin name for settings compatibility. A later store installation/update can replace it; keep the fork ZIP/source so it can be rebuilt or reinstalled.

## Queue storage and recovery

Queue files live in `DECKY_PLUGIN_SETTINGS_DIR/upload-queue-v1/<SteamID64>.json`, outside the installed plugin directory. They contain screenshot identity, chosen visibility, attempts, and retry times, but no authentication credentials or image data. Files are atomically replaced with private permissions; revision checks and file locks reject stale writes from overlapping plugin instances. Corrupt state is surfaced as an error and preserved instead of overwritten.

The Steam client's current screenshot list is authoritative. Queue identity includes the account, game ID, local path, and capture time. Session-local native handles and cloud handles are never used as persistent local identity. If a queued screenshot is removed, it is shown as failed. Manual retry only reactivates failures whose local screenshot still exists.

Steam exposes no idempotency key for screenshot uploads. Status checks, serialization, and restart grace periods reduce duplicate risk; they cannot guarantee exactly-once delivery if Steam commits an upload but never reports it. A hung native request blocks further uploads until it finishes or the plugin is reloaded. Steam's internal interfaces may change; unsupported interfaces or storage errors pause processing and appear in the panel.

## Tests

The test suite covers offline/restart recovery with changed native handles; uploaded-file skipping; concurrent event deduplication; account changes during asynchronous operations; visibility retention; serial uploads; pause; bounded retry and reconnection; ambiguous/late upload completion; deleted screenshots; handle reuse; queue write failures; native pagination; and durable storage/account isolation. Tests use simulated failures and do not disconnect the Deck or upload test images.

## Credits and license

Original plugin by **CodeHz**, with offline catch-up work maintained in **xinxzk/DeckScreenshotManager**. Licensed under the original **BSD-3-Clause** license; see [LICENSE](LICENSE).
