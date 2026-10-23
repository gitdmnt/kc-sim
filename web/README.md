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
it uses the static bundles; it fails if the 出撃 tab scrolls, page or tab content, at 1280×800, 1200×710 or 1024×600),
`bun scripts/screenshot-estimate.ts`, `bun run audit [--offline]`.

## 出撃 workspace

Layout: no header inside poi (the plugin draws the one header: シミュレーション / 観測ログ / 送信設定); a title row when
opened directly. The tabs 出撃 / 海域 / 敵艦 / 推定 / 設定 are a vertical bar (icon + name) on the left. Left column:
編成 (preset selector + ⋯: name, HQ level, poi import of fleet 1–4 or 連合 = fleets 1 + 2, new / duplicate / IO / delete),
艦隊 (通常艦隊 / 機動部隊 / 水上部隊 / 輸送護衛部隊) and the 主力 / 随伴 / 基地 tabs above the fleet. Right column: the
simulator toolbar in the order of use, left to right: 海域 (+ 難易度 for event maps), 出撃 / 単一戦闘 (with node and enemy
comp), 条件 (sliders icon), then 自動 (checkbox) and 実行 (play icon + count, fills with progress), above the results.
出撃 mode also has 目標マス next to the map (default ボス, saved per map in `kcsim:workspace`): the sortie ends at that
node, and the key rates (到達 / 突破 / S勝利 / 旗艦撃沈, gauge) count it instead of the boss (sim-core `config.target`).
条件 has one 能動分岐 choice per `select` node of the map's rules (options labeled by destination), also saved per map;
a node without a saved choice uses `defaults.select` (else the first option), or, when 目標マス is set and that option
cannot reach it, the first option that can (`resolveSelects`).
Enemy combined fleets (e.g. 6-5 M) are not in sim-core: their escort is dropped and the results panel says
「敵連合艦隊 (M) は随伴を除き主力のみで近似」 (also listed under 前提). Left: a one-line fleet
summary (icons: 制空, 速力, 索敵 Cn1–4, ドラム缶, 電探) and the six ships in a 2 × 3 grid like the game; each ship is a
header (number, ship type, name, Lv) over one column of slots (equipment icon, name, ★, 熟練, 搭載); mods, morale and
stats behind ⋯. Right: the key rates as bars on one 0–100% scale (ボス到達 colored by boss rank, 突破 = boss A+ per
sortie, S勝利 = boss S+ per sortie, 大破撤退), secondary numbers, and detail tabs (マス: reach bar colored by rank and
大破撤退 bar per node; 経路: route map with edge width = traversal rate; 損耗; 前提).

Combined fleets: 主力 and 随伴 are edited with the same panel; the formation lists switch to 第一〜第四警戒航行序列
(a formation of the other kind falls back to 単縦陣 / 第四警戒). Results list the main fleet, then the escort (「随伴 …」).
基地: up to three land bases × four squadrons (aircraft only, picked like ship equipment; recon 4 planes, others 18),
each 出撃 / 防空 / 待機. 出撃 bases send two waves at the chosen nodes of the current map (same node twice = both waves
there) before the fleet's battle, in sorties and in 単一戦闘 (waves whose target is the battle's node). 防空 / 待機 bases
do not fly. 「poi から取り込み」 loads poi's bases of the map's area (else the newest area); targets stay as chosen. The
fleet type, escort, land bases and their targets are saved in the preset.

Auto-run (`src/app/sim/useSimRun.ts`): while 自動 is on, every change to the simulated inputs (ships, equipment,
map, difficulty, mode, conditions, estimate settings; not the preset name or note) re-runs 10,000 sorties/battles
300 ms after the last change, cancelling the run in flight. 実行 runs the count chosen in 条件 (default 100,000).
Old results are dimmed and the 実行 button fills with progress. The seed is fixed, so fleet variants are compared on the same
random stream. Map, mode, conditions and 自動 persist in `kcsim:workspace`, the preset in `kcsim:selectedPreset`.

## Design system

Tokens live in `src/styles.css` (`@theme`); primitives in `src/ui`. Icons: `lucide-react` (inline SVG, `currentColor`, works
under the plugin's CSS scoping) and `ui/EquipIcon` (own-drawn equipment category glyphs by `api_type[3]`).

- Spacing 4 / 8 / 12 / 16 / 24 px (`1 2 3 4 6`). One radius, `rounded-md`; `rounded-full` only for meters and dots.
- Surfaces: page `ink-950` → panel `ink-900` (`Card`, full hairline `ink-800`) → raised/control `ink-800`. No one-sided borders,
  inset-shadow stripes or corner decorations on boxes; separate list items with spacing or a full-width hairline.
- Text: `xs` 11px (captions, column heads), `sm` 13px (body), `base` 14px (titles), `lg` 20px (key figures). Numbers tabular and
  right-aligned in one column; units inline.
- Color carries meaning only: `accent` = interactive/selected, `rank-*` = battle ranks, `hp-*` = damage states, node colors =
  node types, `danger` = failure. No gradients, glows, colored frames for OK/NG, decorative badges or emoji.
- Status is shown by icon shape + color or by a data bar, not by a tinted border.

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
