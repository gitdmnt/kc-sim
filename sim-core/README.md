# sim-core

艦これの戦闘と出撃を計算するエンジン(Rust で書き、wasm にビルドする)。モンテカルロ法で勝率、ランク率、ルーティング、ゲージを求める。自艦隊は単艦隊と連合艦隊(機動、水上、輸送護衛)を、敵艦隊は単艦隊と連合艦隊(随伴艦隊 1〜6 隻)を扱う。敵連合艦隊との 6 対 12、12 対 12 の戦闘と、基地航空隊の波状攻撃にも対応する。JSON と TypeScript の契約は `sim_core_types.d.ts` に機械可読な形で定義してあり、`pkg/sim_core.d.ts` に埋め込まれる。説明つきの契約書(SIM_INTERFACE)は非公開のメモである。

```ts
simulateBattle(input: BattleInput, count: number, seed: number): SimulationSummary
runBattle(input: BattleInput, seed: number): RunBattleOutput        // result + post-battle state
hitProbability(query: AttackQuery): HitProbability                   // forward model
damageDistribution(query: AttackQuery): DamageDistribution           // forward model
simulateSortie(input: SortieInput, count: number, seed: number): SortieSummary  // routing + chained battles
```

## ビルドとテスト

```sh
wasm-pack build --target web            # -> pkg/
cargo test                              # unit + integration tests (routing tests read ../server/seed/routing)
cargo test --release --test bench -- --nocapture --test-threads=1   # throughput (battles/s, sorties/s, µs per 201×101 hitProbabilityGrid; asserts >= 50k battles/s); one at a time, or the benches share cores
bun validation/routing-vs-kcnav.ts [--offline]  # routing vs KCNav edge counts -> the private VALIDATION notes (needs pkg/ and the local file)
KCR_DIR=<kancolle-replay checkout> bun validation/battle-vs-kcsim.ts  # realistic sorties + per-node battles vs kcsim -> the private VALIDATION notes §3
```

## 構成

| ファイル | 内容 |
|---|---|
| `src/model.rs` | 契約の serde 型 |
| `src/equipment.rs` | `api_type` による装備の分類、改修・熟練度の効果 |
| `src/ship.rs` | 艦ごとの導出データ(合計値、カットインの種類、対潜攻撃力、対空)と、戦闘中に変わる状態 |
| `src/formation.rs` | 陣形 / 前衛 / 交戦形態のテーブル |
| `src/formulas.rs` | 命中、クリティカル、キャップ、装甲、カスダメージ、轟沈保護 |
| `src/fit.rs` | 装備 id と艦種ごとの主砲フィット(命中 / 軽巡の火力) |
| `src/battle/` | 各フェーズ(`air`、`day` = 先制対潜 + 砲撃、`torpedo`、`night`、`lbas` = 基地航空隊の波)、連合艦隊のフェーズ順、`calc`(順方向モデルと共有する攻撃ごとの補正)、ランク、補給、士気 |
| `src/sim.rs` | `run_battle`、モンテカルロ集計 |
| `src/query.rs` | `hit_probability`、`damage_distribution` |
| `src/routing.rs` | ROUTING_DSL のパーサ / 検証器 / 評価器、索敵式 33 |
| `src/sortie/` | 出撃ループ(マスの処理、撤退、状態の引き継ぎ)、集計、ゲージの推定。`model.rs` は出撃の JSON 型 |
| `src/lib.rs` | wasm-bindgen のエクスポート |
| `tests/` | エンジンの挙動、ランク規則、JSON 契約、公表値との照合、連合艦隊と基地航空隊(`combined.rs`)、ルーティング(全シード文書、開始規則、ゴールデンルート、連合艦隊の指標)、出撃(`fixtures/1-5.api.json` を使う 1-5 のエンドツーエンド。ローカルサーバの API から 1 回だけ取得したもの)、ベンチマーク |
| `validation/` | KCNav とルーティングを比べるハーネスと、比較用のデータスナップショット(結果は非公開の検証メモに書き出す) |

メカニクスと既知の簡略化は非公開のメモ(SIM_INTERFACE)にまとめてある。

## 出典

戦闘式、定数、フェーズの処理は [KC3Kai/kancolle-replay](https://github.com/KC3Kai/kancolle-replay)(`js/kcsim.js`、`js/kcsimcombined.js`、`js/kcships.js`、`js/kcEQDATA.js`)から移植し、[en.kancollewiki.net](https://en.kancollewiki.net/) と照合した。戦闘ランクの規則は KC3Kai の `BattlePrediction` と ElectronicObserver の `kcmemo.md` に従う。

kancolle-replay は MIT ライセンスで配布されている。

```
The MIT License (MIT)
Copyright (c) 2016 fourinone41

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
