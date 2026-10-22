# poi-plugin-sim

KanColle battle / sortie simulator plugin for [poi](https://github.com/poooi/poi) (window-mode plugin).

- 艦隊編成: fleet presets (import from poi, JSON / DeckBuilder import & export)
- 海域 / 敵艦データ: map graph, routing rules, enemy comps and hidden-stat estimates from the data API
- シミュレーション: battle-level Monte Carlo (Rust → wasm, run in a Web Worker)
- 観測ログ: records battle packets while you play (starts when poi loads the plugin, no window needed)

The Rust engine lives in the sibling repo/directory `../sim-core`; the data API in `../data-worker`.

## Build

Requirements: [bun](https://bun.sh) ≥ 1.3, Rust with the `wasm32-unknown-unknown` target, `wasm-pack`.

```sh
cd poi-plugin-sim
bun install
bun run build                 # wasm-pack (../sim-core) + vite → ../poi-plugin-sim-build
SKIP_WASM_BUILD=1 bun run build   # reuse an existing ../sim-core/pkg
```

Output (`../poi-plugin-sim-build`): `index.es`, `package.json` (`main: index.es`), `views/index.js`
(the UI, wasm bytes embedded), `views/sim.worker.js` (the simulation worker), `i18n/`.

Other commands: `bun test`, `bunx tsc --noEmit`, `bun dev` (stand-alone dev page using `dev/sampleState.json`),
`bun run sample` (regenerate the sample state), `bun run screenshots` (needs the data API on :8787).

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

The data API base URL (default `http://127.0.0.1:8787`) is set in the plugin's 設定 tab.
Run it with `cd data-worker && bun run dev`.

## Notes for poi

- poi's plugin window has a strict CSP (`script-src 'self' file://* 'unsafe-inline'`): no `blob:`/`data:` workers and
  no in-page WebAssembly compilation. The simulation therefore runs in a worker loaded from
  `file://…/views/sim.worker.js`, which receives the wasm bytes by message. Keep `sim.worker.js` next to `index.js`.
- Observation capture (`startCapture`) is started from `pluginDidLoad` in poi's main window, listens to `game.response`,
  and stores battles in IndexedDB (`kcsim`).
- Styles are scoped to `.kcsim` and injected only while the plugin UI is mounted.

## Verification notes

Checked with poi 12.0.1 (macOS) on 2026-10-22 using an isolated profile (`--user-data-dir`), not logged in.
