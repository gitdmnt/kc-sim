# poi-plugin-sim

KanColle sortie simulator plugin for [poi](https://github.com/poooi/poi) (window-mode plugin). The simulator UI itself
is the web app in [`../web`](../web), served by the data API's Cloudflare Worker; this plugin:

- **captures** battle and map packets while you play (starts when poi loads the plugin, no window needed) and stores
  them in IndexedDB (`kcsim`),
- **uploads** them to the server automatically (debounced after each battle result and on returning to port, with
  periodic retry and exponential backoff; one request per 60 s, per-install bearer token),
- shows the **観測ログ** (observation log), **送信設定** (server URL, auto upload, registration) and **資源** (resource
  history) views,
- **records the admiral's resources** (燃料 / 弾薬 / 鋼材 / ボーキ and the four materials) whenever they change, in
  IndexedDB (`kcsim-resources`, kept on this machine, never uploaded or sent to the iframe),
- **counts progress of one-time quests** poi's tracker does not cover, from the hand-authored quest conditions it
  bundles (IndexedDB `kcsim-quests`), and
- **embeds the web UI** (the simulator) in an iframe and hands it poi's fleets, master data and quest state with
  `postMessage`, under one chrome the plugin draws (below, "Navigation").

## Navigation

VS Code-style, with the web UI's model (`../web/src/app/nav.tsx`) and component (`../web/src/ui/AppChrome.tsx`): the
left activity bar switches features (global), the top row switches the selected feature's views (local), with the
version at its right end.

| Feature (bar) | Views (top row) | Drawn by |
|---|---|---|
| シミュ | 出撃 / 海域 / 敵艦 / 観測ログ / 送信設定 / 計算設定 | 観測ログ, 送信設定: the plugin; the others: the iframe |
| 任務 | (title only) | the iframe |
| 資源 | 推移 / 増減 (イベント) / 増減 (日別) (range, admiral and resource toggles stay in the view) | the plugin |
| 設定 (gear, bottom) | (title only): the web UI's app-wide settings (sample data, deleting presets, data cache, reset) | the iframe |

- The iframe stays mounted (hidden while a plugin view is shown) and shows the last web view picked; the plugin sends
  it with `view` and the web UI draws no bars of its own. A move the web UI makes itself (海域 →「出撃シミュ」) comes
  back as `view` and selects 出撃 in the plugin's top row.
- The current view is saved in the plugin's localStorage (`kcsim:view`, the same key and ids as the web UI); switching
  features returns to the feature's last view in the session.
- macOS: the plugin window has no title bar; the traffic-light buttons (~80 × 28 px, reserved as 120 × 42 px) sit at the top left and poi lays
  a 23 px `-webkit-app-region: drag` strip over the top. The top row spans the window and starts its tabs 192 px in
  (`pl-48`, version `pr-12`); the activity bar starts below the top row (y = 61 px; the row is 60 px high, the bar 96 px wide); the top row's tabs are `no-drag`,
  the rest of the row still drags the window. Elsewhere the corner above the bar shows the app icon.

The Rust engine lives in `../sim-core` (used by the web UI); the server in `../server`.

## Build

Requirements: [bun](https://bun.sh) ≥ 1.3.

```sh
cd poi-plugin-sim
bun install
bun run build        # prebuild: (cd ../web && bun install --frozen-lockfile)
```

The plugin's views and chrome use the web UI's parts and stylesheet (`../web/src`), whose Tailwind CSS resolves from
`../web/node_modules`; `bun run build` and `bun run dev` therefore install `../web`'s dependencies first
(`bun run deps:web`). `react`, `react-dom` and `lucide-react` imported from `../web/src` resolve to this package's copies
(`resolve.dedupe` in `vite.config.ts`; a second React breaks hooks).

Output (`../poi-plugin-sim-build`): `index.es`, `package.json` (`main: index.es`), `views/index.js` (capture, upload,
the plugin's views and their CSS scoped to `.kcsim`), `i18n/`. No wasm and no worker: the simulation runs in the web UI.

Other commands: `bun test`, `bunx tsc --noEmit`, `bun run dev` (below), `bun run screenshots` (starts both dev servers,
writes `docs/screenshots/{05-log-list,06-log-detail,08-plugin-upload,19-plugin-embedded,20-plugin-resources,21-plugin-resources-delta,22-plugin-quests}.png`
at 1024x600, with poi's macOS drag strip and window buttons drawn over the top left; the 資源 shots use generated
history from `dev/resourcesSeed.ts` and the 任務 shot the local data API's quests; map data comes from the static
bundles when the API has no enemy comps for 4-2 (a local D1 without the KCNav ingest). It fails unless the bar and the top
row stay in place in every feature and view, no tab sits under the window buttons, the tabs in the drag strip are
`no-drag`, the plugin's tabs switch the iframe's view and the iframe's own moves come back, the embedded web UI draws no
bars, the 4-2 sortie reaches the boss, and no page (the plugin's or the iframe's) scrolls at 1280x800 / 1200x710 / 1024x600), `bun dev/resources-smoke.ts`
(feeds a scripted sequence of API responses through `startCapture` the way poi does, and prints what was recorded, a
restart and the thinning).

## Layout

| Path | Role |
|---|---|
| `src/poi/index.tsx` | poi entry (vite lib build): redux `connect` for `info` / `const`, inline CSS, `startCapture` exports |
| `src/panel/PluginPanel.tsx` | The plugin's view: the chrome (`AppChrome` from `@web/ui`), the iframe and the plugin's own views |
| `src/panel/WebFrame.tsx`, `src/panel/bridge.ts` | The iframe and the plugin side of the embed protocol |
| `src/panel/log/`, `src/panel/UploadSettings.tsx` | Observation log and upload settings (UI parts from `@web/*` = `../web/src`) |
| `src/panel/resources/` | 資源 view: line charts (own SVG, no chart library) and the 増減 tables |
| `src/settings.ts` | Plugin settings (`kcsim:plugin`: server URL, auto upload) and the one-time upgrade from the old in-plugin UI |
| `src/capture/` | Packet capture, IndexedDB, upload client, auto upload |
| `src/resources/` | Resource history: recording, thinning (`history.ts`), IndexedDB (`store.ts`), view maths (`view.ts`) |
| `dev/` | Dev page: the plugin's view without poi (`bun run dev`, http://localhost:5174) |

`bun run dev` serves `dev/index.html` with vite and reproduces poi's window mode: the page plays poi's main window
(the plugin's React tree and its `postMessage` calls run there) and renders the view with `createPortal` into a child
window it opens with `window.open`, flagged `isWindowMode = true` (allow pop-ups for localhost, or use the button on
the page). `?mode=tab` renders the view in the page itself, like poi's tab mode (the iframe is refused). The poi state
is the web UI's sample state; the iframe opens `?server=` (default `http://localhost:5173/`, i.e.
`cd ../web && bun run dev`).

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

The server URL (default `https://kc-sim.udama.net/`) is set in シミュ → 送信設定: the iframe opens it and
observations are uploaded to its origin. Only `https://` URLs are accepted, plus `http://` on `localhost`, `127.0.0.1`
and `[::1]` (a local `cd ../server && bun run dev` is `http://127.0.0.1:8787/` after `cd ../web && bun run build`).

**Upgrading from the in-plugin UI** (first start, `src/settings.ts`): a fresh install uploads automatically. An upgrade
whose old API base was the old production worker (`kc-sim-data.lumpoler.workers.dev`) or already the new host
(`kc-sim.udama.net`) keeps its auto-upload setting, and its registration is moved to the new origin (same D1, so the
client id stays valid).
Every other upgrade (the old default `http://127.0.0.1:8787`, or any other server) starts with auto upload **off**, so
nothing is sent to production without the user turning it on. The old UI's keys (`kcsim:settings`, `kcsim:cache:*`,
`kcsim:tab`, `kcsim:map`, `kcsim:selectedPreset`) are removed; presets, registration and upload state are kept.

## Resource history (資源)

- **When:** `startCapture` also listens for resources. poi updates its redux store before it fires `game.response`
  (`views/env-parts/data-resolver`), so on every response the plugin reads `info.resources` (poi's order: 燃料, 弾薬,
  鋼材, ボーキ, 高速建造材, 高速修復材, 開発資材, 改修資材) and `info.basic.api_member_id`. That covers everything poi
  tracks: `api_port/port`, `api_get_member/material`, `api_req_hokyu/charge`, `api_req_kousyou/*` (開発・建造・解体・
  廃棄・改修, 高速建造), `api_req_nyukyo/start` / `speedchange`, `api_req_air_corps/supply` / `set_plane`.
- **What:** a snapshot `{admiral, t, v[8], event, via?}` only when the values differ from that admiral's last snapshot
  (also across restarts: the last one is read back from IndexedDB). `event` is the API path that changed them. Some
  APIs move resources in the game but not in poi's store until the next sync (遠征 `api_req_mission/result`, 任務
  `api_req_quest/clearitemget`, resource nodes `api_req_map/start|next` with `api_itemget`, 改造, アイテム使用); they
  are listed in `via` of the next snapshot (e.g. 「母港 (遠征・任務)」), and dropped when a full sync (port / material)
  shows no change.
- **Storage:** IndexedDB `kcsim-resources` (separate from the observation log, so clearing that does not touch it),
  one row per snapshot, indexed by `[admiral, t]`; one history per admiral id. Thinning runs after the first snapshot
  of a session and then daily: the last 7 days are kept whole (per-event 増減), up to 90 days the last snapshot of each
  hour, older ones the last of each local day; a kept snapshot counts what it absorbed (`merged`). A heavy player
  stays around a few thousand rows plus 365 a year.
- **View:** 推移 (step lines, 燃料・弾薬・鋼材・ボーキ and the materials on separate scales), 増減 (イベント) and 増減 (日別),
  ranges 1日 / 1週 / 1月 / 全期間, a toggle per resource (showing its current value and the change over the range), an
  admiral selector when several have history. Only the 増減 table scrolls; the page does not. Without history (outside
  poi, or before the first port) it shows 「資源の記録がありません」.

## Quest progress (任務カウンタ)

poi counts only the quests of its `quest_goal.cson` (~130, essentially periodic ones). For the others, `startCapture`
also runs a `QuestCounter` (`src/quests/counter.ts`) on every `game.response`:

- **Which quests:** in progress in poi's `info.quests.activeQuests` (`api_state` 2), not in poi's `records`, and with
  countable sub-goals in the bundled `shared/quest/overrides.json` (`shared/quest/progress.ts` `questGoals`; schema and
  semantics in docs/QUEST_OVERRIDES.md). New overrides reach players with the next plugin build.
- **Events:** `api_req_map/start` remembers the map, the sortie fleet (ships in order with master stype / ctype / level)
  and the gauge number, `start` / `next` the cell and whether it is the boss (`api_event_id` 5 or `api_bosscell_no`),
  `api_req_sortie|combined_battle/battleresult` counts the rank there; `api_req_practice/battle` + `battle_result`;
  `api_req_mission/result` (success or great success; mission id from the fleet's `api_mission`, else by name);
  `api_req_kousyou/createitem` (attempts), `createship`, `destroyitem2` / `destroyship` and `api_req_kaisou/powerup`
  (the scrapped / consumed items are looked up in the state of the previous response, since poi removes them before the
  event), `remodel_slot`, `api_req_kaisou/remodeling` (the new form = the old form's `api_aftershipid`), `hokyu/charge`,
  `nyukyo/start`. Combined fleets are checked on the main fleet.
- **Reset:** a quest's counts are deleted on `api_req_quest/clearitemget` and when a 全て questlist (tab 0) no longer
  lists it. 「本日中」 goals restart at 05:00 JST.
- **Storage:** IndexedDB `kcsim-quests`, one row per admiral (`{admiral, quests: {id: {goalKey: {count, day?}}}}`);
  saves are announced on a `BroadcastChannel` (`kcsim-quest-progress`) so the plugin window re-reads them.
- **To the web UI:** the panel (`src/poi/index.tsx`) turns the stored counts into goals for every active countable
  quest (`countedGoals`) and the bridge merges them into `quests.records` with `source: "kcsim"` where poi has no record.

## Embedding the web UI

Protocol: [`shared/embed/protocol.ts`](../shared/embed/protocol.ts). Every message is
`{ src: "kcsim", v, type, ...fields }`:

| Direction | `type` | Fields | When |
|---|---|---|---|
| web → plugin | `ready` | `v` = the web UI's protocol version | once the web UI listens |
| plugin → web | `view` | `view`: `sortie` / `map` / `enemy` / `sim-settings` / `quests` / `settings` (`WEB_VIEWS`) | after every `ready`, first; then when the user picks another web view in the plugin's chrome |
| plugin → web | `state` | `info`, `const?`, `combinedFlag?`, `quests?` | after every `ready` (with `const`), then when the parts below change (coalesced, 250 ms); `const` only when it changes |
| plugin → web | `presets` | `json` (`kcsim-presets` export) | after `ready`, until acknowledged once for that origin |
| web → plugin | `presets-ack` | `imported`, `skipped`, `persisted` | after the import |
| web → plugin | `view` | `view` (as above) | the web UI moved by itself (海域 →「戦闘シミュ」/「出撃シミュ」), only to plugins of v3 or later; not echoed back |

- **One chrome (v3):** the plugin draws the only bars ("Navigation" above), in the same place for every feature and
  view, and picks the iframe's view with `view`. The web UI hides its own bars once a message of v3 or later arrives
  (and while it waits for the first one). The plugin's own views (観測ログ, 送信設定, 資源) are never sent.
- **Compatibility:** the web UI is deployed at once and accepts v1–v3. Inside a v2 plugin (0.2.x: one header row
  シミュレーション / 観測ログ / 資源 / 送信設定) it draws its own bars below that header (シミュ: 出撃 / 海域 / 敵艦 /
  計算設定, 任務, 設定), so everything still works with two rows of tabs until poi loads the v3 plugin. A v3 plugin in
  front of an older web UI (a stale self-hosted server) gets no reaction to `view`: the web UI keeps its own sidebar
  and the plugin's web tabs do not switch it. v2 removed v1's `hostViews` / `host` / `open-view`.

- **Data:** the plugin sends only what the web UI reads (shared/fleet/poiImport.ts, the catalog, the map tab):
  `info.basic.api_level`; `info.fleets[]` as `{api_id, api_name, api_ship}`; per ship instance `api_id, api_ship_id,
  api_lv, api_slot, api_onslot, api_slotnum, api_slot_ex, api_kyouka, api_maxhp, api_nowhp, api_karyoku, api_raisou,
  api_taiku, api_soukou, api_kaihi, api_taisen, api_sakuteki, api_lucky, api_leng, api_soku, api_cond`; per equipment
  instance `api_id, api_slotitem_id, api_level, api_alv`; land bases `info.airbase[]` as `{api_area_id, api_rid,
  api_name, api_action_kind, api_plane_info[]: {api_squadron_id, api_state, api_slotid, api_count, api_max_count}}`;
  poi's `sortie.combinedFlag` as the message's `combinedFlag` (0–3); `const.{$ships, $equips, $shipTypes,
  $equipTypes, $mapareas}`; and for the 任務 tab `quests` = `{list, active, records}`: the last 全て questlist (`api_no`,
  `api_state`, `api_type`, `api_progress_flag` only) that the plugin's reducer (`src/quests/reducer.ts`, exported as the
  plugin's `reducer`, held by poi at `state.ext["poi-plugin-sim-build"]._`) saw this session, poi's
  `info.quests.activeQuests` reduced to the same four fields, and poi's progress counters `info.quests.records`
  (`{key, description, count, required}` per sub-goal) plus the plugin's own counts for quests poi does not track (same
  shape, `source: "kcsim"`; see "Quest progress"). Everything else (the admiral's name and member id, including
  `api_member_id` on each fleet, base distances, missions, resources, quest titles) is dropped, by the plugin before
  posting and again by the web UI on receipt. It goes to the iframe and nowhere else; the web UI never uploads it.
- **Origins and senders:** the plugin posts with the server URL's origin as the target and accepts messages only from
  the iframe's window with that origin. In poi's window mode the plugin's code runs in poi's main window and its view is
  portaled into the plugin window, so the sender the iframe sees is the main window, i.e. `window.parent.opener`. The
  web UI therefore accepts messages from `window.parent` or `window.parent.opener`, only with origin `file://` (poi's
  plugin window; `null` is still accepted until a real poi confirms which string it reports, then it should go;
  `http://localhost` only in the web UI's dev server), validates the shape and ignores unknown types. Its own messages
  to the parent carry no data beyond counts and use target `*` (a `file://` page cannot be targeted by origin).
- **Versions:** `v` is the sender's protocol version. Adding an optional field keeps it; any other change bumps it. The
  web UI is deployed at once and keeps accepting the previous version for at least one plugin release; a plugin
  version it does not accept shows "プラグインを更新してください". A newer web UI makes the plugin show a short notice.
- **Preset migration:** presets saved by the old in-plugin UI (`kcsim:preset:*` in the plugin's localStorage) are sent
  once per server origin. The web UI imports them without overwriting or duplicating (`importJSON(…, { skipExisting })`)
  and acknowledges with `persisted`: whether its preset store is real localStorage (it falls back to memory when the
  iframe's storage is blocked). Only a `persisted: true` ack makes the plugin record `kcsim:presetsMigrated:<origin>`;
  otherwise the presets are sent again on the next `ready`. The plugin's copies are kept.
- **iframe:** `sandbox="allow-scripts allow-same-origin"` (no forms, pop-ups, downloads or top navigation; the web UI
  uses none), `allow="clipboard-write"` (copy buttons), `referrerpolicy="no-referrer"`.

## Notes for poi

- **Window mode only.** poi 12's main window runs with `nodeIntegration` and `nodeIntegrationInSubFrames`
  (`app.ts`), so an iframe there could get Node.js. Plugin windows (window mode) are created with
  `nodeIntegration: false` (`lib/webcontent-utils.ts`), and poi sets `window.isWindowMode = true` on them. The plugin
  embeds the web UI only when the window hosting its view has `isWindowMode === true` and no Node.js (`require` /
  `process.versions.node`), so any other window is refused; in poi's tab mode it shows 「ウィンドウモードで開いてください」
  instead. 観測ログ, 送信設定 and 資源 work in both modes.
- **Portal.** Code that touches `window` / `document` from the plugin's views must use the view's own window
  (`element.ownerDocument.defaultView`): the global `window` is poi's main window. The dialogs (`web/src/ui/Modal.tsx`)
  do this for Esc and focus.
- **CSP.** poi's plugin window has `script-src https://www.google-analytics.com 'self' file://* 'unsafe-inline'` and no
  `default-src` / `frame-src`, so an https iframe is not blocked. The embedder's CSP does not apply inside the
  cross-origin frame (the web UI's worker and wasm load from its own origin).
- **Storage.** The web UI inside poi stores its presets and settings in its own origin's storage as seen from poi
  (separate from the same site opened in a browser). Changing the server URL, or moving the server to another host,
  starts from empty storage there (presets are migrated again from the plugin's old copies; newer presets must be
  moved with JSON export/import).
- Observation capture (`startCapture`) is started from `pluginDidLoad` in poi's main window, listens to `game.response`,
  and stores battles in IndexedDB (`kcsim`) and resource snapshots in IndexedDB (`kcsim-resources`).
- Styles are scoped to `.kcsim` and injected only while the plugin view is mounted.

## Verification notes

The embedding path (the main-window sender seen as `parent.opener`, the portal into a child window with
`isWindowMode`, Esc in the portaled log drawer, the tab-mode refusal) is exercised in a browser with the dev page.
Not yet checked in a real poi window: whether the iframe has no Node.js, the origin string poi reports (`file://` or
`null`), and whether the iframe's storage survives a poi restart.
Previously checked with poi 12.0.1 (macOS) on 2026-10-22 using an isolated profile (`--user-data-dir`), not logged in.
The resource history is checked against poi 12's reducer (`views/redux/info/resources.js`, read from the installed
app) and its dispatch-before-event order by `bun dev/resources-smoke.ts`; not yet with a logged-in poi.
