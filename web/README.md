# web

The kc-sim web UI. The simulation runs in the browser (sim-core wasm in a Web Worker). The server's
Cloudflare Worker serves `dist/` as static assets next to the data API, so the UI calls `/api/v1/*` on its own origin.
The poi plugin (`../poi-plugin-sim`) embeds this page in an iframe, sends poi's fleets and master data with
`postMessage` and picks the view (protocol: [`shared/embed/protocol.ts`](../shared/embed/protocol.ts), described in the
plugin's README).

## Navigation

VS Code-style, one model for the browser and the plugin (`src/app/nav.tsx`), drawn by one component
(`src/ui/AppChrome.tsx`): the left activity bar (icon + short name, 64 px) switches features, the top row switches the
selected feature's views (a feature with one view shows its title there instead), with the version at its right end.

| Feature (bar) | Views (top row) |
|---|---|
| シミュ (シミュレーション) | 出撃 (the workspace: map, fleet editor and results on one screen without page scroll), 海域 (maps and routing), 敵艦 (enemy ships: one row per master id, elite / flagship marked, with stats, equipment and the server's hidden-stat estimates, [ESTIMATOR.md](../docs/ESTIMATOR.md) "UI"), 計算設定 (サーバの推定値を使う, 観測を優先する遭遇数); in the plugin also 観測ログ and 送信設定 |
| 任務 | one view (prerequisite trees, below) |
| 資源 | plugin only: 推移 / 増減 (イベント) / 増減 (日別) |
| 設定 (gear, bottom) | one view: the sample-data switch, deleting presets, clearing the data cache, resetting the settings |

Opened directly, this page draws the bars with the features it has (シミュ without 観測ログ / 送信設定, 任務, 設定).
Inside a plugin of protocol v3 or later the plugin draws the bars, sends the view to show (`view`) and hears back when
this page moves by itself (海域 →「戦闘シミュ」/「出撃シミュ」, `nav.go({ view: "sortie", … })`); the page then draws no
bars. Inside an older plugin (v2, one header row of its own) the page draws its bars below the plugin's header.
The current view is saved in `kcsim:view` (switching features returns to the feature's last view in the session);
the old `kcsim:tab` (出撃 / 海域 / 敵艦 / 任務 / 設定 bar, `estimate` → `enemy`) is moved over once. The two-column
layouts start at a document width of 928 px (`--breakpoint-lg`): the plugin's 1024 px window gives the iframe 928 px (1024 − the 96 px bar),
the same content width as this page at 1024 px with its own bar.

## Commands

Requirements: [bun](https://bun.sh) ≥ 1.3, Rust with the `wasm32-unknown-unknown` target, `wasm-pack`.

```sh
bun install
bun run dev                    # vite on http://localhost:5173, /api → http://127.0.0.1:8787 (KCSIM_API to change)
bun run build                  # wasm-pack (../sim-core) + vite → dist/
SKIP_WASM_BUILD=1 bun run build   # reuse an existing ../sim-core/pkg (also for dev)
bun test
bun run typecheck
```

`bun run dev` builds `../sim-core/pkg` before it listens and rebuilds it whenever `../sim-core/src`, `Cargo.toml`,
`Cargo.lock` or `sim_core_types.d.ts` change (edits, `git merge` / `pull`); the page reloads on the new pkg, and a
failed build shows in the error overlay. HMR updates the TypeScript at once, so without the rebuild the new runner
would read summary fields the old wasm does not produce. `SKIP_WASM_BUILD=1` serves the existing pkg and does not watch.

`dist/`: `index.html`, `assets/` (hashed JS, CSS, `sim.worker-*.js`, `sim_core_bg-*.wasm`) and, when
`../server/dist/maps` exists (`cd ../server && bun run export:bundle`), `maps/` (the static map bundles the UI reads
when `/api` fails). Deploying: `cd ../server && bun run deploy` builds this first (private deployment notes).

Scripts: `bun run sample` (regenerate `src/sampleState.json` from `@kancolle/data`), `bun run screenshots`
(`docs/screenshots/` or `SHOTS_DIR`, file prefix `SHOTS_PREFIX`; docs keep `23-web-sortie` only; with the API down, e.g.
`KCSIM_API=http://127.0.0.1:9`, it uses the static bundles, and it takes map data from them when the API has no enemy
comps for the shot's map (a local D1 without the KCNav ingest); it fails if the bars are not シミュ / 任務 / 設定 with
出撃 / 海域 / 敵艦 / 計算設定, if the sample fleet never reaches the boss, or if the 出撃 tab scrolls, page or tab
content, at 1280×800, 1200×710 or 1024×600), `bun run audit [--offline]`.

## 出撃 workspace

Layout: left column:
編成 (preset selector + ⋯: name, HQ level, poi import of fleet 1–4 or 連合 = fleets 1 + 2, new / duplicate / IO / delete),
艦隊 (通常艦隊 / 機動部隊 / 水上部隊 / 輸送護衛部隊 / 遊撃部隊) and the 主力 / 随伴 / 支援 / 友軍 / 基地 tabs above the fleet. Right column: the
simulator toolbar in the order of use, left to right: 海域 (+ 難易度 for event maps), 出撃 / 単一戦闘 (with node and enemy
comp), 条件 (sliders icon), then 自動 (checkbox) and 実行 (play icon + count, fills with progress), above the results.
出撃 mode also has 目標マス next to the map (default ボス, saved per map in `kcsim:workspace`): the sortie ends at that
node, and the key rates (到達 / 突破 / S勝利 / 旗艦撃沈, gauge) count it instead of the boss (sim-core `config.target`).
条件 has one 能動分岐 choice per `select` node of the map's rules (options labeled by destination), also saved per map;
a node without a saved choice uses `defaults.select` (else the first option), or, when 目標マス is set and that option
cannot reach it, the first option that can (`resolveSelects`).
Enemy combined fleets (e.g. 6-5 M) are sent with their escort and fought as 6 vs 12 / 12 vs 12 (formations 11–14 →
第一〜第四警戒航行序列); results list the enemy main fleet, then its escort. Left: a one-line fleet
summary (icons: 制空, 速力, 索敵 Cn1–4, ドラム缶, 電探) and the six ships in a 2 × 3 grid like the game (one column, scrolling
inside the panel, when the panel is under 36rem wide, e.g. at 1024 / 1200 px, so names stay readable); each ship is a
header (number, ship type, name, Lv) over one column of slots (equipment icon, name, ★, 熟練, 搭載); mods, morale and
stats behind ⋯. Right: the key rates as bars on one 0–100% scale (ボス到達 colored by boss rank, 突破 = boss A+ per
sortie, S勝利 = boss S+ per sortie, 大破撤退), secondary numbers (周回, 旗艦撃沈, 資源/出撃, 入渠, 護衛退避, 出撃間の待ち),
and detail tabs (マス: reach bar colored by rank, 退避 and 大破撤退 per node; 経路: route map with edge width = traversal
rate; 損耗: per ship damage, docking time, bauxite, damage control, evacuation; 資源; ゲージ when a gauge is set; 前提).

出撃 条件 has five tabs (`src/app/sim/conditions/`; 撤退・消費・ゲージ・マス・資源・艦隊 are saved in `kcsim:workspace`, ゲージ /
マス and the 基地空襲 / 友軍 nodes per map in `sortieMaps`; start, flags and formations are not saved):
- 基本: night policy, 撤退 (大破撤退 `onHeavy`, ダメコン所持艦は進撃 `allowDamecon`, 中破撤退 `onModerate`, 護衛退避
  `useFcf` with the flagship's command facility 107 / 272 / 413 shown), ボス前の消費 (洋上補給 `policy.underway`,
  戦闘糧食 `policy.rations`), start, 能動分岐, flags, formations per node, phase / gauge number, count and seed.
- 艦隊 (`conditions/ExtraFleets.tsx`, also in 単一戦闘's 条件): 道中支援 / 決戦支援 on/off with a type (編成から / 航空 /
  砲撃 / 長距離雷撃 / 対潜) → `SortieInput.support {node, boss}` (単一戦闘: `BattleInput.support`, 決戦 at the boss); 友軍艦隊
  on/off, arrival % and node (default 目標マス) → `friendFleet`; 基地空襲: the node raided on arrival, chance and the
  node whose enemy comps raid → `baseRaids` (単一戦闘: the chosen comp raids every base with squadrons, `baseRaid`).
- マス: 進撃 / 撤退 / 強行 after each node (`policy.advance`: retreat / push), 煙幕 per battle node (`policy.smoke`;
  barrage-balloon nodes from `shared/sim/nodeEffects.ts` are marked 気球 and sent as `SortieNode.balloons`), gains of
  resource and landing nodes (`SortieNode.resource`) and losses of maelstroms (`SortieNode.maelstrom`).
- ゲージ: kind 撃破 (ボス旗艦撃沈) / HP / 輸送 (TP) and remaining (`gauge`), HP final threshold and final comps, TP tank
  force and TP per S win, additional gauges (`gauge.phases`: kind, remaining, phase), morale carried until the gauge
  breaks (`gauge.morale`) and 連続出撃 (`consecutive`).
- 資源: 高速修復材 above a docking time (`repair.bucketAboveSec`) and costs per sortie the engine does not model
  (`extraPerSortie`; support expedition costs are counted by the engine, `supportCostMean`).

The 資源 tab shows net fuel / ammo / steel / bauxite / buckets / docking time per sortie (mean, median, 90%) and per
gauge clear, docking costs, land-base cost, underway replenishment / rations used and node effects; ゲージ shows sorties
to clear (mean, median, 90%), capped runs, morale waits, sorties per gauge and resources per clear.
遊撃部隊 is a single fleet of up to seven ships (sent as `striking: true`); a stored seven-ship 通常艦隊 loads as one.

Combined fleets: 主力 and 随伴 are edited with the same panel; the formation lists switch to 第一〜第四警戒航行序列
(a formation of the other kind falls back to 単縦陣 / 第四警戒). Results list the main fleet, then the escort (「随伴 …」).
支援: 道中支援 / 決戦支援 fleets (6 ships each) and 友軍: the friend fleet (7 ships, any master ship via 「全艦から選ぶ」), edited
with the same panel and saved in the preset (`supportNode` / `supportBoss` / `friendFleet`). Results show 支援 / 友軍 per
node (マス), 基地空襲 (rate, defence air state and base HP lost in its tooltip) and the support cost (資源); 単一戦闘 shows
支援到達 / 友軍来援 / 防空の制空.
基地: up to three land bases × four squadrons (aircraft only, picked like ship equipment; recon 4 planes, others 18),
each 出撃 / 防空 / 待機. 出撃 bases send two waves at the chosen nodes of the current map (same node twice = both waves
there) before the fleet's battle, in sorties and in 単一戦闘 (waves whose target is the battle's node). 防空 bases
defend against 基地空襲 (`LandBase.defense`); 待機 bases do nothing; with a raid set, every base with squadrons can be
hit. Squadron radius (`api_distance`) and the node's `lbasDistance` drop waves beyond reach (sim-core warning).
「poi から取り込み」 loads poi's bases of the map's area (else the newest area); targets stay as chosen. The
fleet type, escort, support / friend fleets, land bases and their targets are saved in the preset.

Auto-run (`src/app/sim/useSimRun.ts`): while 自動 is on, every change to the simulated inputs (ships, equipment,
map, difficulty, mode, conditions, estimate settings; not the preset name or note) re-runs 10,000 sorties/battles
300 ms after the last change, cancelling the run in flight. 実行 runs the count chosen in 条件 (default 100,000).
Old results are dimmed and the 実行 button fills with progress. The seed is fixed, so fleet variants are compared on the same
random stream. Map, mode, conditions and 自動 persist in `kcsim:workspace`, the preset in `kcsim:selectedPreset`.

## 任務 tab

`src/app/quests/QuestTab.tsx`, over `GET /api/v1/quests` (cached per data version: kept while the boot view's
`dataVersion` equals the version in the response's ETag, 24 h when boot fails; docs/DATA_SOURCES.md §14) and `shared/quest/tree.ts`.
Three full-height cards that scroll inside (no page scroll at 1280×800 / 1200×710 / 1024×600, checked by
`bun scripts/screenshot-quests.ts`, which also writes `docs/screenshots/17-quests.png`, `18-quest-progress.png`, a
one-time quest with counts from the plugin, `19-quest-filters.png`, a filtered list and a quest with 選択報酬,
`24-quest-doable.png`, 実施可能 on with poi state injected, and `25-quest-tree.png`, A88's tree after 「すべて開く」, all at
1024×600; it also fails if a title in the fully expanded A88 or B117 tree is narrower than about 8 characters). The tab
shows only what the user cannot infer from the UI itself: no boxed status badges, no captions that restate what is
visible, no provenance chatter.

- **List:** search by code / name / id, combined with three dropdown filters (`QuestFilters.tsx` over
  `shared/quest/filter.ts`): 種別 (単発 / デイリー / ウィークリー / マンスリー / クォータリー / イヤリー / 期間限定; key
  `freq`) and 分類 (A 編成 … G 改装, その他; key `cat`), both from the wiki code (`Bq3`, `2610B3`, `L2610F2`, `Cs8` 季節限定
  → 期間限定), and 状況 (未開放 = not unlocked yet, 未達成 = 受注可, 遂行中 = 遂行中・達成, 達成済, 不明; only shown with
  poi's quest state). Each option shows how many quests it would leave given the other filters and the search. Below
  them the 「実施可能」 toggle (defined below) with how many quests it would leave given the other filters; when on, it
  notes how many 不明 quests it left out. Without poi's quest state and roster it is disabled (「poi 接続時のみ」).
  Filters persist in `kcsim:questFilter` (a saved `open`, the former 未達成 = 受注可・未開放, loads as 未開放 + 未達成; a
  saved filter without `doable` loads with the toggle off), the selection in `kcsim:quest`. A status dot per quest, a
  check mark on 実施可能 quests (「条件未確認」 instead when some condition could not be checked); the row tooltip has the
  description, conditions and a reward summary.
- **Quest:** 種別 and the status (dot + text) in the header; description, the structured clear conditions (the
  override, else kcwiki-quest-data) and the override's `note`; with poi's data, the shortfall of a quest that is not
  実施可能 (「不足: 潜水空母/潜水艦 0/2」) and conditions that could not be checked, as plain text; rewards
  (`QuestRewards.tsx`, plain text: resources with a coloured dot and the number in the normal colour, fixed items joined
  by 「、」, one 「選択1: A / B / C」 line per 選択報酬 group; the KC3 memo's `[獲]` part is hidden then); the progress; the
  prerequisite tree (below); and at the bottom one 「出典:」 line linking the sources this quest's data came from (the
  override's reference page, kcwiki-quest-data, KC3Kai, kcanotify).
- **Prerequisite tree** (`PrerequisiteTree.tsx` over `prerequisiteOutline` in `shared/quest/tree.ts`). Two kinds of
  link, drawn differently:
  - **Chain:** a quest with exactly one prerequisite has it on the next row at the *same* indent, and a vertical line
    joins the two status dots: "requires the one below". A linear run (B74 → A71 → B72) reads as one column.
  - **Branches:** a quest with two or more prerequisites has each of them one indent step (10 px) further in, joined to
    it by guide lines with an elbow under its ▸ toggle. Branches are ordered by id.

  So indentation only grows where the graph forks: the 40+-quest trees of A88 / B117 stay within 5 levels and every
  title keeps at least about 8 characters at 1024×600 (A88 was 16 levels as a plain tree). The target's own
  prerequisites are the top level (a single one too). The graph is a DAG, so a quest reached a second time (a shared
  ancestor) is a one-line muted reference (↰) instead of a repeated subtree; clicking it opens the rows down to the
  full one, scrolls to it and highlights it. The ▸ toggle sits on the head of a chain and on every quest with branches
  (rows inside a chain have none: a chain folds at its head); a closed row shows how many quests it hides (「+12」).
  Open at first: down to the second indent level and every branch leading to a 受注可 / 遂行中 quest (the player's
  frontier); closed: rows whose prerequisites are all 達成済 / 達成, and anything deeper. 「すべて開く」 / 「畳む」 switch
  between everything and that default. Cycles are cut at the closing edge and unknown ids shown as such (both noted
  under the tree). Clicking a row selects that quest.
- **必要なもの:** 「未達成の前提任務を含む」: ships and equipment named by the conditions of the tree's quests that are not
  yet cleared, merged into one line per requirement. Ship lines that resolve to the same master ships are one line
  (an override's master ids and the upstream name for the same ships, 駆逐 / 駆逐艦), else lines with identical names;
  a ship line keeps the largest amount any quest asks, because each quest needs the ships at its own time and they
  stay (modernization material, 改修素材, is used up and summed). Equipment is summed, because exchanges, conversions
  and scraps use it up. Counts are plain text and only a shortfall stands out: 「0/2」 (owned/needed) in red; otherwise
  the needed count, muted (「×4」, also without poi data); 「?/2」 when a name does not resolve. Ownership comes from
  poi's ships and equipment (a named ship also matches its later remodels; ship-type words and classes resolve through
  the master data; overrides name master ids, ship types, classes or equipment categories, which match exactly). An
  empty 艦娘 or 装備 section is left out. Below: 後続任務, the quests this one unlocks.

Status (poi state `quests`, protocol.ts `PoiQuests`): 達成 / 遂行中 / 受注可 straight from the game's list; 達成済 (inferred:
an ancestor of a listed quest) and 未開放 (inferred: after a listed one-time quest). Without the 全て list (poi restarted,
quest screen not opened since) only poi's active quests feed the inference; without poi everything is 不明 and nothing is
matched against owned ships.

実施可能 (`shared/quest/doable.ts` `questDoability`), only with poi's quest state and roster:

1. **Unlocked:** status 受注可, 遂行中 or 達成 (the 未達成 and 遂行中 groups). 不明 counts as unlocked only while poi has not
   seen the 全て list and the quest has prerequisites that are all inferred 達成済; with the
   全て list a quest missing from it is not takeable (cleared earlier or not offered), and a quest without prerequisites
   gives nothing to infer from. Every other 不明 quest is left out and counted (「不明 N 件は除外」). Inferred quests may
   already be cleared (one-time) or out of season (期間限定): opening the 全て list settles them.
2. **Owned:** every ship, ship-type / class count and piece of equipment the quest's own conditions name (the override
   first, else kcwiki-quest-data) is owned in the needed amount, by the same matching and counting as 必要なもの
   (`aggregateRequirements`). Needs of the prerequisite path do not count. An `or` list needs one alternative (an
   `and` / `then` list of `or`s: one combination); a quest that misses shows the shortfall of the closest alternative.
   Levels, ★, 熟練 and fleet positions are not checked.
3. **条件未確認:** a quest without structured conditions, a free-text `other` condition, or a name the master data lacks
   cannot be checked; such a quest still counts as 実施可能 and is marked 「条件未確認」 (the detail lists those conditions).

Progress counts: poi already counts every relevant event for the quests in its `assets/data/quest_goal.cson` (130,
essentially the dailies / weeklies / monthlies / quarterlies / yearlies) and keeps them in `info.quests.records`; the tab
shows those counts (e.g. `2/5`, one per sub-goal) instead of counting again. For active quests poi does not track, the
plugin counts the mechanical conditions of the hand-authored overrides itself (docs/QUEST_OVERRIDES.md; sortie boss /
node ranks per map with fleet checks, exercises, expeditions, scraps, ...) and sends them as `records` goals with
`source: "kcsim"`; the tab labels those 「進捗 (kc-sim)」 and lists one line per sub-goal. Other quests show the game's own
`api_progress_flag` (50% / 80%) or 達成.

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
| A normal browser | None: presets can be imported as JSON, and the 出撃 tab offers 「内蔵サンプルデータを使う」 (bundled sample ships and equipment; the 設定 gear shows the switch while it is on) |
| `bun run dev` without a parent | `myState.json` (a dumped poi state, gitignored) or `src/sampleState.json`, served at `/__dev/state.json` |

Presets and settings live in this origin's localStorage (`kcsim:*`).

## Layout

| Path | Role |
|---|---|
| `src/main.tsx` | Entry: starts the poi bridge, renders `KcsimApp` |
| `src/KcsimApp.tsx` | Root: poi state (or sample), catalog, `.kcsim` theme root |
| `src/poiBridge.ts` | Web side of the embed protocol |
| `src/app/` | Views; `Shell.tsx` (chrome and views), `nav.tsx` (features, views, saved view, nav intents) |
| `src/data/` | Data API client (`/api`, cached in localStorage), static bundle fallback (`/maps`) |
| `src/fleet/`, `src/sim/` | Presets and catalog; simulation runner, adapters and the worker (`sim.worker.ts`) |
| `src/ui/` | UI parts, including the chrome `AppChrome.tsx` (also used by the plugin through `@web/*`) |
