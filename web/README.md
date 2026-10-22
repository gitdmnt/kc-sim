# web

The kc-sim web UI. Tabs: 出撃 (the workspace: map, fleet editor and results on one screen without page scroll),
海域 (maps and routing), 敵艦 (enemy data), 推定 (the server's hidden-stat estimates), 設定. The simulation runs in the
browser (sim-core wasm in a Web Worker). The server's
Cloudflare Worker serves `dist/` as static assets next to the data API, so the UI calls `/api/v1/*` on its own origin.
The poi plugin (`../poi-plugin-sim`) embeds this page in an iframe and sends poi's fleets and master data with
`postMessage` (protocol: [`shared/embed/protocol.ts`](../shared/embed/protocol.ts), described in the plugin's README).

## Commands

Requirements: [bun](https://bun.sh) ≥ 1.3, Rust with the `wasm32-unknown-unknown` target, `wasm-pack`.

```sh
bun install
bun run dev                    # vite on http://localhost:5173, /api → http://127.0.0.1:8787 (KCSIM_API to change)
bun run build                  # wasm-pack (../sim-core) + vite → dist/
SKIP_WASM_BUILD=1 bun run build   # reuse an existing ../sim-core/pkg
bun test
bun run typecheck
```

`dist/`: `index.html`, `assets/` (hashed JS, CSS, `sim.worker-*.js`, `sim_core_bg-*.wasm`) and, when
`../server/dist/maps` exists (`cd ../server && bun run export:bundle`), `maps/` (the static map bundles the UI reads
when `/api` fails). Deploying: `cd ../server && bun run deploy` builds this first ([docs/DEPLOY.md](../docs/DEPLOY.md)).

Scripts: `bun run sample` (regenerate `src/sampleState.json` from `@kancolle/data`), `bun run screenshots`
(`docs/screenshots/` or `SHOTS_DIR`, file prefix `SHOTS_PREFIX`; with the API down, e.g. `KCSIM_API=http://127.0.0.1:9`,
it uses the static bundles; it fails if the 出撃 tab scrolls at 1280×800 or 1200×710),
`bun scripts/screenshot-estimate.ts`, `bun run audit [--offline]`.

## 出撃 workspace

Header: tabs, then the workspace toolbar (海域, 難易度 for event maps, 出撃 / 単一戦闘 with node and enemy comp,
条件 popover, 自動, 実行). Left: preset selector + ⋯ (name, HQ level, poi import, new / duplicate / IO / delete), a
one-line fleet summary, one row per ship (equipment in two columns; mods, morale and stats behind ⋯). Right: the key
rates (突破 = boss A+ per sortie, ボス到達, S勝利 = boss S+ per sortie, 大破撤退), rank bar, secondary numbers and
detail tabs (nodes, route map, damage, assumptions).

Auto-run (`src/app/sim/useSimRun.ts`): while 自動 is on, every change to the simulated inputs (ships, equipment,
map, difficulty, mode, conditions, estimate settings; not the preset name or note) re-runs 10,000 sorties/battles
300 ms after the last change, cancelling the run in flight. 実行 runs the count chosen in 条件 (default 100,000).
Old results are dimmed and a 2 px bar shows progress. The seed is fixed, so fleet variants are compared on the same
random stream. Map, mode, conditions and 自動 persist in `kcsim:workspace`, the preset in `kcsim:selectedPreset`.

## poi data

| Where the page runs | poi state |
|---|---|
| In the plugin's iframe | From the plugin (`src/poiBridge.ts`) |
| A normal browser | None: presets can be imported as JSON, and the 出撃 tab offers 「内蔵サンプルデータを使う」 (bundled sample ships and equipment; 設定 shows the switch while it is on) |
| `bun run dev` without a parent | `myState.json` (a dumped poi state, gitignored) or `src/sampleState.json`, served at `/__dev/state.json` |

Presets and settings live in this origin's localStorage (`kcsim:*`).

## Layout

| Path | Role |
|---|---|
| `src/main.tsx` | Entry: starts the poi bridge, renders `KcsimApp` |
| `src/KcsimApp.tsx` | Root: poi state (or sample), catalog, `.kcsim` theme root |
| `src/poiBridge.ts` | Web side of the embed protocol |
| `src/app/` | Tabs |
| `src/data/` | Data API client (`/api`, cached in localStorage), static bundle fallback (`/maps`) |
| `src/fleet/`, `src/sim/` | Presets and catalog; simulation runner, adapters and the worker (`sim.worker.ts`) |
| `src/ui/` | UI parts (also used by the plugin's views through `@web/*`) |
