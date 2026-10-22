# poi-plugin-sim

KanColle sortie simulator plugin for [poi](https://github.com/poooi/poi) (window-mode plugin). The simulator UI itself
is the web app in [`../web`](../web), served by the data API's Cloudflare Worker; this plugin:

- **captures** battle and map packets while you play (starts when poi loads the plugin, no window needed) and stores
  them in IndexedDB (`kcsim`),
- **uploads** them to the server automatically (debounced after each battle result and on returning to port, with
  periodic retry and exponential backoff; one request per 60 s, per-install bearer token),
- shows the **観測ログ** (observation log) and **送信設定** (server URL, auto upload, registration) tabs, and
- **embeds the web UI** (シミュレータ tab) in an iframe and hands it poi's fleets and master data with `postMessage`.

The Rust engine lives in `../sim-core` (used by the web UI); the server in `../server`.

## Build

Requirements: [bun](https://bun.sh) ≥ 1.3.

```sh
cd poi-plugin-sim
bun install
bun run build
```

Output (`../poi-plugin-sim-build`): `index.es`, `package.json` (`main: index.es`), `views/index.js` (capture, upload,
the plugin's views and their CSS scoped to `.kcsim`), `i18n/`. No wasm and no worker: the simulation runs in the web UI.

Other commands: `bun test`, `bunx tsc --noEmit`, `bun run dev` (below), `bun run screenshots` (starts both dev servers,
writes `docs/screenshots/{05-log-list,06-log-detail,08-plugin-upload,19-plugin-embedded}.png`).

## Layout

| Path | Role |
|---|---|
| `src/poi/index.tsx` | poi entry (vite lib build): redux `connect` for `info` / `const`, inline CSS, `startCapture` exports |
| `src/panel/PluginPanel.tsx` | The plugin's view: シミュレータ (iframe) / 観測ログ / 送信設定 |
| `src/panel/WebFrame.tsx`, `src/panel/bridge.ts` | The iframe and the plugin side of the embed protocol |
| `src/panel/log/`, `src/panel/UploadSettings.tsx` | Observation log and upload settings (UI parts from `@web/*` = `../web/src`) |
| `src/settings.ts` | Plugin settings (`kcsim:plugin`: server URL, auto upload) |
| `src/capture/` | Packet capture, IndexedDB, upload client, auto upload |
| `dev/` | Dev page: the plugin's view without poi (`bun run dev`, http://localhost:5174) |

`bun run dev` serves `dev/index.html` with vite. It renders the plugin's view with the web UI's sample state and embeds
the web UI from `?server=` (default `http://localhost:5173/`, i.e. `cd ../web && bun run dev`).

## Install into poi

poi loads plugins from `~/Library/Application Support/poi/plugins/node_modules` (macOS;
`%APPDATA%\poi\plugins\node_modules` on Windows, `~/.config/poi/plugins/node_modules` on Linux).

1. Build (above).
2. Link the build output as a plugin. Using a `file:` dependency keeps it from being pruned by poi's own `npm install` at startup:
   ```sh
   cd "$HOME/Library/Application Support/poi/plugins"
   cp package.json package.json.bak            # back up first
   npm pkg set dependencies.poi-plugin-sim-build="file:/ABSOLUTE/PATH/TO/poi-plugin-sim-build"
   ln -s /ABSOLUTE/PATH/TO/poi-plugin-sim-build node_modules/poi-plugin-sim-build   # if npm did not create it
   ```
3. Restart poi. The plugin appears in the plugin drawer (chevron next to the plugin tab) as 「シミュ」 / *Simulator for Integrated Management*. Rebuilding updates it in place (restart poi or use the plugin reload).

The server URL (default `https://kc-sim.lumpoler.workers.dev/`) is set in the 送信設定 tab: the iframe opens it and
observations are uploaded to its origin. Only `https://` URLs are accepted, plus `http://` on `localhost`, `127.0.0.1`
and `[::1]` (a local `cd ../server && bun run dev` is `http://127.0.0.1:8787/` after `cd ../web && bun run build`).

## Embedding the web UI

Protocol: [`shared/embed/protocol.ts`](../shared/embed/protocol.ts). Every message is
`{ src: "kcsim", v, type, ...fields }`:

| Direction | `type` | Fields | When |
|---|---|---|---|
| web → plugin | `ready` | `v` = the web UI's protocol version | once the web UI listens |
| plugin → web | `state` | `info`, `const?` | after every `ready` (with `const`), then when the parts below change (coalesced, 250 ms); `const` only when it changes |
| plugin → web | `presets` | `json` (`kcsim-presets` export) | after `ready`, until acknowledged once for that origin |
| web → plugin | `presets-ack` | `imported`, `skipped` | after the import |

- **Data:** the plugin sends only what the web UI reads: `info.{basic.api_level, fleets, ships, equips}` and
  `const.{$ships, $equips, $shipTypes, $equipTypes, $mapareas}` (no admiral name, member id, resources or quests).
  It goes to the iframe and nowhere else; the web UI never uploads it.
- **Origins:** the plugin posts with the server URL's origin as the target and accepts messages only from the iframe's
  window with that origin. The web UI accepts messages only from `window.parent` with origin `file://` (poi's plugin
  window; `null` is accepted too, and `http://localhost` only in the web UI's dev server), validates the shape and
  ignores unknown types. Its own messages to the parent carry no data beyond counts and use target `*` (a `file://`
  page cannot be targeted by origin).
- **Versions:** `v` is the sender's protocol version. Adding an optional field keeps it; any other change bumps it. The
  web UI is deployed at once and keeps accepting the previous version for at least one plugin release; a plugin
  version it does not accept shows "プラグインを更新してください". A newer web UI makes the plugin show a short notice.
- **Preset migration:** presets saved by the old in-plugin UI (`kcsim:preset:*` in the plugin's localStorage) are sent
  once per server origin. The web UI imports them without overwriting or duplicating (`importJSON(…, { skipExisting })`)
  and acknowledges; the plugin then records `kcsim:presetsMigrated:<origin>`. The plugin's copies are kept.
- **iframe:** `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"`
  (no top navigation), `allow="clipboard-write"` (copy buttons), `referrerpolicy="no-referrer"`.

## Notes for poi

- **Window mode only.** poi 12's main window runs with `nodeIntegration` and `nodeIntegrationInSubFrames` (`app.js`),
  so an iframe there could get Node.js. Plugin windows (window mode) are created with `nodeIntegration: false`
  (`lib/webcontent-utils.js`). The plugin embeds the web UI only when the window hosting its view has no Node.js
  (`require` / `process.versions.node`); in poi's tab mode it shows 「ウィンドウモードで開いてください」 instead. The log
  and upload tabs work in both modes.
- **CSP.** poi's plugin window has `script-src https://www.google-analytics.com 'self' file://* 'unsafe-inline'` and no
  `default-src` / `frame-src`, so an https iframe is not blocked. The embedder's CSP does not apply inside the
  cross-origin frame (the web UI's worker and wasm load from its own origin).
- **Storage.** The web UI inside poi stores its presets and settings in its own origin's storage as seen from poi
  (separate from the same site opened in a browser). Changing the server URL, or moving the server to another host,
  starts from empty storage there (presets are migrated again from the plugin's old copies; newer presets must be
  moved with JSON export/import).
- Observation capture (`startCapture`) is started from `pluginDidLoad` in poi's main window, listens to `game.response`,
  and stores battles in IndexedDB (`kcsim`).
- Styles are scoped to `.kcsim` and injected only while the plugin view is mounted.

## Verification notes

The embedding (window-mode detection, the iframe's lack of Node.js, `file://` as the message origin, storage that
survives a poi restart) has been exercised only in a browser with the dev page, not yet in a real poi window.
Previously checked with poi 12.0.1 (macOS) on 2026-10-22 using an isolated profile (`--user-data-dir`), not logged in.
