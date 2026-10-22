# web

The kc-sim web UI: fleet presets, maps and routing, enemy data, battle and sortie simulation, the server's
hidden-stat estimates, settings. The simulation runs in the browser (sim-core wasm in a Web Worker). The server's
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
(`docs/screenshots/`, needs the server on :8787), `bun scripts/screenshot-estimate.ts`, `bun run audit [--offline]`.

## poi data

| Where the page runs | poi state |
|---|---|
| In the plugin's iframe | From the plugin (`src/poiBridge.ts`), badge 「poi 接続中」 |
| A normal browser | None (「poi 未接続」): presets can be imported as JSON, and 設定 → 「内蔵サンプルデータを使う」 switches to the bundled sample ships and equipment. Without master data the fleet and simulation tabs say so |
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
