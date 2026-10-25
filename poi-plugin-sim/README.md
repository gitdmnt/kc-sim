# poi-plugin-sim

[poi](https://github.com/poooi/poi) 用の艦これ出撃シミュレータープラグイン(ウィンドウモードのプラグイン)。
npm では [`poi-plugin-kc-sim`](https://www.npmjs.com/package/poi-plugin-kc-sim) として公開している。
シミュレーターの UI は [`../web`](../web) の Web アプリで、データ API の Cloudflare Worker が配信する。
プラグインの役割は次のとおり。

- 戦闘とマップのパケットを捕捉し、IndexedDB(`kcsim`)に保存する。
  捕捉は poi がプラグインを読み込んだ時点で始まり、ウィンドウを開く必要はない。
- 自動送信がオンなら(新規インストールではオン)、捕捉したものをサーバにアップロードする。
  各戦闘結果のあとと母港に戻ったときにデバウンスして送り、定期的な再試行と指数バックオフも行う。
  リクエストは 60 秒に 1 回で、インストールごとの bearer トークンを使う。
- 観測ログ、送信設定(サーバ URL、自動送信、登録)、資源(資源の履歴)のビューを表示する。
- 提督の資源(燃料、弾薬、鋼材、ボーキと 4 種の資材)を、変化するたびに IndexedDB(`kcsim-resources`)に記録する。
  記録はこのマシンにだけ残し、アップロードも iframe への送信もしない。
- poi のトラッカーが扱わない一回限りの任務の進捗を、同梱した手書きの任務条件で数える(IndexedDB `kcsim-quests`)。
- poi の艦隊、マスターデータ、任務の状態を `postMessage` で渡し、iframe に Web UI(シミュレーター)を埋め込む。
  クロームはプラグインが 1 つだけ描く(下記「ナビゲーション」)。

## ナビゲーション

VS Code 風の構成で、Web UI のモデル(`../web/src/app/nav.tsx`)とコンポーネント(`../web/src/ui/AppChrome.tsx`)を使う。
左のアクティビティバーで機能を切り替え(グローバル)、上の行で選択中の機能のビューを切り替える(ローカル)。
右端にはバージョンを表示する。

| 機能(バー) | ビュー(上の行) | 描画するもの |
|---|---|---|
| シミュ | 出撃 / 海域 / 敵艦 / 観測ログ / 送信設定 / 計算設定 | 観測ログ、送信設定: プラグイン。それ以外: iframe |
| 任務 | (タイトルのみ) | iframe |
| 資源 | 推移 / 増減 (イベント) / 増減 (日別)(期間、提督、資源のトグルはビューの中に残る) | プラグイン |
| 設定(歯車、最下部) | (タイトルのみ): Web UI のアプリ全体の設定(サンプルデータ、プリセットの削除、データキャッシュ、リセット) | iframe |

- iframe はマウントしたままにし(プラグインのビューを表示している間は隠す)、最後に選んだ Web のビューを表示する。
  ビューはプラグインが `view` で送り、Web UI は自前のバーを描かない。
  Web UI 内での移動(海域 →「出撃シミュ」)は `view` として戻り、プラグインの上の行で 出撃 が選択される。
- 現在のビューはプラグインの localStorage(`kcsim:view`。キーと ID は Web UI と共通)に保存する。
  機能を切り替えると、セッション内でその機能の最後のビューに戻る。
- macOS では、プラグインのウィンドウにタイトルバーがない。
  信号機のボタン(約 80 × 28 px。120 × 42 px を確保)が左上にあり、poi は上端に 23 px の `-webkit-app-region: drag` の帯を重ねる。
  上の行はウィンドウの全幅にわたり、タブは 192 px 内側から始まる(`pl-48`、バージョンは `pr-12`)。
  アクティビティバーは上の行の下から始まる(y = 61 px。行の高さは 60 px、バーの幅は 96 px)。
  上の行のタブは `no-drag` で、行のそれ以外の部分ではウィンドウをドラッグできる。
  ほかの OS では、バーの上端の角にアプリのアイコンを表示する。

Rust のエンジンは `../sim-core`(Web UI が使う)に、サーバは `../server` にある。

## ビルド

必要なもの: [bun](https://bun.sh) ≥ 1.3。

```sh
cd poi-plugin-sim
bun install
bun run build        # prebuild: (cd ../web && bun install --frozen-lockfile)
```

プラグインのビューとクロームは、Web UI の部品とスタイルシート(`../web/src`)を使う。
その Tailwind CSS は `../web/node_modules` から解決されるので、`bun run build` と `bun run dev` は先に `../web` の依存を入れる(`bun run deps:web`)。
`../web/src` から import した `react`、`react-dom`、`lucide-react` は、このパッケージ側のコピーに解決される(`vite.config.ts` の `resolve.dedupe`)。
React が 2 つ読み込まれるとフックが壊れるためである。

出力先は `../poi-plugin-sim-build`(npm パッケージ `poi-plugin-kc-sim`)で、中身は次のとおり。

- `index.es`
- `package.json`(生成する。下記を参照)
- `views/index.js`(捕捉、アップロード、プラグインのビューと、`.kcsim` にスコープした CSS)
- `i18n/`
- `README.md`(`README.npm.md` のコピー。ユーザー向けの npm ページ)
- `LICENSE`
- `THIRD_PARTY_NOTICES`(`views/index.js` に同梱した lucide-react、react-redux、use-sync-external-store、Tailwind の CSS、kcwiki-quest-data と kancolle-replay のデータ。同梱するパッケージが変わったら更新する)

wasm もワーカーも含まない。シミュレーションは Web UI で動く。
React と ReactDOM は外部扱いにしている。
poi 12 が提供するのは React 18.3 なので、プラグインのコードで React 19 専用の API は使えない。

出力の `package.json` は、`package.build.json` にこのディレクトリの `package.json` の `version` を加えて作る(vite.config.ts の `packageJson()`)。
バージョンを持つのはこのディレクトリの `package.json` だけである。
パッケージ名は、poi がプラグインの reducer に使うキー(`state.ext["poi-plugin-kc-sim"]`)も兼ねる。
`src/quests/reducer.ts` はこの名前を `package.build.json` から読む。

ほかのコマンドは次のとおり。

- `bun test`、`bunx tsc --noEmit`
- `bun run dev`(下記)
- `bun run screenshots`:
  2 つの開発サーバを起動し、`docs/screenshots/{05-log-list,06-log-detail,08-plugin-upload,19-plugin-embedded,20-plugin-resources,21-plugin-resources-delta,22-plugin-quests}.png` を 1024x600 で書き出す。
  poi の macOS のドラッグ帯とウィンドウボタンは左上に重ねて描く。
  資源のスクリーンショットは `dev/resourcesSeed.ts` が生成した履歴を、任務のスクリーンショットはローカルのデータ API の任務を使う。
  API に 4-2 の敵編成がなければ(KCNav を取り込んでいないローカル D1)、マップのデータは静的なバンドルから取る。
  次のどれかに当たると失敗する。
  どの機能やビューでもバーと上の行が定位置に留まらない、ウィンドウボタンの下にタブがある、ドラッグ帯の中のタブが `no-drag` でない、プラグインのタブで iframe のビューが切り替わらない、iframe 内の移動が戻ってこない、埋め込んだ Web UI がバーを描く、4-2 の出撃がボスに到達しない、1280x800 / 1200x710 / 1024x600 のいずれかでページ(プラグインのものも iframe のものも)がスクロールする。
- `bun dev/resources-smoke.ts`:
  poi と同じように、台本どおりの API 応答の列を `startCapture` に流し、記録内容、再起動、間引きの結果を出力する。

## 構成

| パス | 役割 |
|---|---|
| `src/poi/index.tsx` | poi のエントリ(vite の lib ビルド): `info` / `const` の redux `connect`、インライン CSS、`startCapture` のエクスポート |
| `src/panel/PluginPanel.tsx` | プラグインのビュー: クローム(`@web/ui` の `AppChrome`)、iframe、プラグイン自身のビュー |
| `src/panel/WebFrame.tsx`、`src/panel/bridge.ts` | iframe と、埋め込みプロトコルのプラグイン側 |
| `src/panel/log/`、`src/panel/UploadSettings.tsx` | 観測ログと送信設定(UI の部品は `@web/*` = `../web/src` から) |
| `src/panel/resources/` | 資源ビュー: 折れ線グラフ(自前の SVG。グラフのライブラリは使わない)と 増減 のテーブル |
| `src/settings.ts` | プラグインの設定(`kcsim:plugin`: サーバ URL、自動送信、アップロードの通知)と、旧プラグイン内 UI からの 1 回限りのアップグレード |
| `src/capture/` | パケットの捕捉、IndexedDB、アップロードクライアント、自動送信 |
| `src/resources/` | 資源の履歴: 記録、間引き(`history.ts`)、IndexedDB(`store.ts`)、ビューの計算(`view.ts`) |
| `dev/` | 開発ページ: poi なしのプラグインのビュー(`bun run dev`、http://localhost:5174) |
| `package.build.json`、`index.es`、`i18n/`、`README.npm.md`、`LICENSE`、`THIRD_PARTY_NOTICES` | npm パッケージのマニフェスト(`version` なし)、poi のエントリ、翻訳、npm ページ、ライセンス。出力にコピーする |

`bun run dev` は vite で `dev/index.html` を配信し、poi のウィンドウモードを再現する。
ページが poi のメインウィンドウの役を担い(プラグインの React ツリーと `postMessage` の呼び出しはここで動く)、`window.open` で開いた子ウィンドウに `createPortal` でビューを描く。
子ウィンドウには `isWindowMode = true` を立てる(localhost のポップアップを許可するか、ページのボタンを使う)。
`?mode=tab` を付けると、poi のタブモードと同じくビューをページ自体に描く(iframe は拒否される)。
poi の状態には Web UI のサンプルの状態を使う。
iframe は `?server=` を開く(既定は `http://localhost:5173/`。つまり `cd ../web && bun run dev`)。

## poi へのインストール

ユーザーは poi → 設定 → プラグイン で、npm から `poi-plugin-kc-sim` をインストールする(poi がプラグインのディレクトリで `npm install` を実行する)。

開発時は、npm のリリース版の代わりにビルドの出力をリンクする。
poi は `~/Library/Application Support/poi/plugins/node_modules/poi-plugin-*` からプラグインを読み込む(macOS。Windows は `%APPDATA%\poi\plugins\node_modules`、Linux は `~/.config/poi/plugins/node_modules`)。
先に poi を終了しておく。
`file:` 依存にしておけば、poi 自身が `npm install` を実行してもリンクは消えない。

```sh
cd "$HOME/Library/Application Support/poi/plugins"
cp package.json package.json.bak            # back up first
npm install /ABSOLUTE/PATH/TO/poi-plugin-sim-build   # adds "poi-plugin-kc-sim": "file:…" and the symlink node_modules/poi-plugin-kc-sim
```

poi を再起動すると、プラグインドロワー(プラグインタブの隣のシェブロン)に「シミュ」(ほかの言語では *kc-sim*)が現れる。
再ビルドした内容はそのまま反映される(poi を再起動するか、プラグインのリロードを使う)。
リンクと npm のリリース版は同じパッケージなので、両方は入れない(`npm uninstall poi-plugin-kc-sim` でどちらも削除できる)。

### 0.4.0 より前のリンク名

以前の手順で用意したプラグインのディレクトリには、`"poi-plugin-sim-build": "file:…/poi-plugin-sim-build"` とシンボリックリンク `node_modules/poi-plugin-sim-build` がある。
この状態でも動く(poi はプラグイン名をリンク先の `package.json` から取り、現在は `poi-plugin-kc-sim` になる)。
ただし poi の更新ボタンと削除ボタンは `node_modules/poi-plugin-kc-sim` を対象にするので、リンクの隣に npm のリリース版を入れてしまう。
poi を終了した状態で、npm のリリース版か、新しい名前のリンクに切り替える。
観測ログ、設定、資源の履歴は poi のストレージにあるので、切り替えても残る。

```sh
cd "$HOME/Library/Application Support/poi/plugins" && npm uninstall poi-plugin-sim-build && npm install poi-plugin-kc-sim
# or, to keep loading the local build:
cd "$HOME/Library/Application Support/poi/plugins" && npm uninstall poi-plugin-sim-build && npm install /ABSOLUTE/PATH/TO/poi-plugin-sim-build
```

### サーバ URL

サーバ URL(既定は `https://kc-sim.udama.net/`)は シミュ → 送信設定 で設定する。
iframe はこの URL を開き、観測はこのオリジンにアップロードする。
受け付けるのは `https://` の URL と、`localhost`、`127.0.0.1`、`[::1]` の `http://` だけである。
ローカルの `cd ../server && bun run dev` は、`cd ../web && bun run build` のあと `http://127.0.0.1:8787/` で動く。

### 自動送信

自動送信の設定は `src/settings.ts` が扱う。
新規インストール(poi の localStorage に `kcsim:` のキーがない)では、自動送信はオンで始まる。
オンの間、送信設定 には 閉じる を押すまで通知を表示する。
通知に示すのは、アップロードに含まれるもの、サーバのオリジン、オフにするボタンである。
アップロードに含むのは各出撃のマップパケット、生の戦闘と戦闘結果の応答、出撃艦隊、司令部レベルで、提督の名前と ID、演習、資源、任務は含まない(`capture/db.ts` の `uploadPending`)。
閉じる を押すと通知が消える(`uploadNoticeClosed`)。
観測ログへの捕捉は、この設定に関係なく行う。
保存済みの `kcsim:plugin` がある場合は、その `autoUpload` をそのまま使う。

### 旧プラグイン内 UI からのアップグレード

初回起動時に `src/settings.ts` が処理する。
旧 API のベースが旧本番 Worker(`kc-sim-data.lumpoler.workers.dev`)か新しいホスト(`kc-sim.udama.net`)だった場合は、自動送信の設定を引き継ぎ、登録を新しいオリジンに移す(D1 は同じなので、クライアント ID はそのまま使える)。
それ以外(旧既定の `http://127.0.0.1:8787` やほかのサーバ)からのアップグレードでは、自動送信はオフで始まる。
ユーザーがオンにしない限り、本番には何も送らない。
旧 UI のキー(`kcsim:settings`、`kcsim:cache:*`、`kcsim:tab`、`kcsim:map`、`kcsim:selectedPreset`)は削除し、プリセット、登録、アップロードの状態は残す。

## リリース(npm)

1. `package.json` の `version` を上げる(semver。バージョンを持つのはここだけ)。
   埋め込みプロトコルのバージョンを変えるリリースでは、先に Web UI がそのバージョンを受け付けるようにしておく(「Web UI の埋め込み」のバージョンの項)。
2. `bun install && bunx tsc --noEmit && bun test && bun run build`。
3. `cd ../poi-plugin-sim-build && npm pack --dry-run` でパッケージを確認する。
   新しいバージョンで、`LICENSE`、`README.md`、`THIRD_PARTY_NOTICES`、`i18n/ja-JP.json`、`index.es`、`package.json`、`views/index.js` だけが並べばよい。
4. `../poi-plugin-sim-build` で `npm publish --access public` を実行する(パッケージの所有者として `npm login` が必要)。
5. コミットして `v<version>` のタグを付け(`git tag v0.4.0`)、`--tags` 付きでプッシュする。
   インストール済みのユーザーには、poi が npm の `latest` タグを見て更新を知らせる。

## 資源の履歴(資源)

- **タイミング**:
  `startCapture` は資源も監視する。
  poi は `game.response` を発火する前に redux ストアを更新する(`views/env-parts/data-resolver`)ので、プラグインは応答のたびに `info.resources` と `info.basic.api_member_id` を読む。
  `info.resources` の並びは poi の順序で、燃料、弾薬、鋼材、ボーキ、高速建造材、高速修復材、開発資材、改修資材である。
  対象は poi が追跡する API すべてで、`api_port/port`、`api_get_member/material`、`api_req_hokyu/charge`、`api_req_kousyou/*`(開発、建造、解体、廃棄、改修、高速建造)、`api_req_nyukyo/start` / `speedchange`、`api_req_air_corps/supply` / `set_plane` を含む。
- **内容**:
  スナップショット `{admiral, t, v[8], event, via?}` は、その提督の直前のスナップショットと値が異なるときだけ記録する。
  再起動をまたいでも同じで、直前のものは IndexedDB から読み戻す。
  `event` は変化を起こした API のパスである。
  ゲーム内では資源が動くのに、poi のストアには次の同期まで反映されない API もある(遠征 `api_req_mission/result`、任務 `api_req_quest/clearitemget`、`api_itemget` を伴う資源マス `api_req_map/start|next`、改造、アイテム使用)。
  これらは次のスナップショットの `via` に並べ(たとえば「母港 (遠征・任務)」)、全体の同期(母港 / 資材)で値が変わっていなければ捨てる。
- **保存**:
  IndexedDB `kcsim-resources` に保存する。
  観測ログとは別なので、観測ログを消してもこちらは残る。
  スナップショット 1 件を 1 行とし、`[admiral, t]` を索引にする。
  履歴は提督 ID ごとに 1 つある。
  間引きはセッションの最初のスナップショットのあとと、1 日ごとに行う。
  直近 7 日間は全件を残し(イベントごとの 増減 に使う)、90 日までは 1 時間ごと、それより古いものは現地時間の 1 日ごとに最後のスナップショットを残す。
  残したスナップショットは、吸収した件数(`merged`)を持つ。
  よく遊ぶプレイヤーでも、数千行に 1 年あたり 365 行を足した程度に収まる。
- **ビュー**:
  推移(階段状の線。燃料、弾薬、鋼材、ボーキと資材は目盛りを分ける)、増減 (イベント)、増減 (日別) がある。
  期間は 1日 / 1週 / 1月 / 全期間から選び、資源ごとのトグルには現在値と期間内の変化を表示する。
  履歴が複数あるときは提督を選べる。
  スクロールするのは 増減 のテーブルだけで、ページはスクロールしない。
  履歴がないとき(poi の外、または最初の母港の前)は「資源の記録がありません」と表示する。

## 任務の進捗(任務カウンタ)

poi が数えるのは `quest_goal.cson` にある任務(約 130 件で、ほぼ周期任務)だけである。
それ以外の任務を数えるため、`startCapture` は `game.response` のたびに `QuestCounter`(`src/quests/counter.ts`)も実行する。

- **対象の任務**:
  poi の `info.quests.activeQuests` で進行中(`api_state` 2)で、poi の `records` になく、同梱の `shared/quest/overrides.json` に数えられるサブゴールがあるもの(`shared/quest/progress.ts` の `questGoals`)。
  スキーマは `server/src/questOverrides.ts` の zod 定義にある。
  オーバーライドを追加すると、次のプラグインのビルドでプレイヤーに届く。
- **イベント**:
  - `api_req_map/start` はマップ、出撃艦隊(艦を順に、マスターの stype / ctype / レベル付きで)、ゲージ番号を覚える。
  - `start` / `next` はマスと、そこがボスかどうか(`api_event_id` 5 または `api_bosscell_no`)を覚える。
  - `api_req_sortie|combined_battle/battleresult` は、そのマスでのランクを数える。
  - `api_req_practice/battle` + `battle_result`。
  - `api_req_mission/result`(成功または大成功。遠征 ID は艦隊の `api_mission` から取り、なければ名前で引く)。
  - `api_req_kousyou/createitem`(試行)、`createship`、`destroyitem2` / `destroyship`、`api_req_kaisou/powerup`。
    廃棄や消費したアイテムは、直前の応答の状態から探す(poi がイベントの前にそれらを取り除くため)。
  - `remodel_slot`、`api_req_kaisou/remodeling`(新しい艦 = 古い艦の `api_aftershipid`)、`hokyu/charge`、`nyukyo/start`。

  連合艦隊は主力艦隊で判定する。
- **リセット**:
  任務のカウントは、`api_req_quest/clearitemget` のときと、全て の任務リスト(タブ 0)からその任務が消えたときに削除する。
  「本日中」のゴールは 05:00 JST に数え直す。
- **保存**:
  IndexedDB `kcsim-quests` に、提督ごとに 1 行(`{admiral, quests: {id: {goalKey: {count, day?}}}}`)で保存する。
  保存すると `BroadcastChannel`(`kcsim-quest-progress`)で通知し、プラグインのウィンドウが読み直す。
- **Web UI への受け渡し**:
  パネル(`src/poi/index.tsx`)は、保存したカウントを、数えられる受注中の全任務のゴールに変換する(`countedGoals`)。
  ブリッジはそれを `source: "kcsim"` 付きで `quests.records` に統合する。
  統合するのは poi に記録がない部分だけである。

## Web UI の埋め込み

プロトコルは [`shared/embed/protocol.ts`](../shared/embed/protocol.ts) にある。
メッセージはすべて `{ src: "kcsim", v, type, ...fields }` の形をとる。

| 方向 | `type` | フィールド | タイミング |
|---|---|---|---|
| Web → プラグイン | `ready` | `v` = Web UI のプロトコルバージョン | Web UI が待ち受けを始めたとき |
| プラグイン → Web | `view` | `view`: `sortie` / `map` / `enemy` / `sim-settings` / `quests` / `settings`(`WEB_VIEWS`) | `ready` のたびに最初に送る。以後はユーザーがプラグインのクロームで別の Web ビューを選んだとき |
| プラグイン → Web | `state` | `info`、`const?`、`combinedFlag?`、`quests?` | `ready` のたびに(`const` 付きで)送る。以後は下記の対象が変わったとき(250 ms でまとめる)。`const` は変わったときだけ |
| プラグイン → Web | `presets` | `json`(`kcsim-presets` の書き出し) | `ready` のあと、そのオリジンで 1 回確認されるまで |
| Web → プラグイン | `presets-ack` | `imported`、`skipped`、`persisted` | 取り込みのあと |
| Web → プラグイン | `view` | `view`(上と同じ) | Web UI 内で移動したとき(海域 →「戦闘シミュ」/「出撃シミュ」)。v3 以降のプラグインにだけ送り、プラグインは送り返さない |

- **クロームの一本化(v3)**:
  バーを描くのはプラグインだけである(上の「ナビゲーション」)。
  バーはどの機能やビューでも同じ位置にあり、iframe のビューは `view` で選ぶ。
  Web UI は、v3 以降のメッセージを受け取ったあと(と、最初のメッセージを待つ間)は自前のバーを隠す。
  プラグイン自身のビュー(観測ログ、送信設定、資源)は送らない。
- **互換性**:
  Web UI は一括でデプロイされ、v1〜v3 を受け付ける。
  v2 のプラグイン(0.2.x。シミュレーション / 観測ログ / 資源 / 送信設定 のヘッダ行が 1 つ)の中では、そのヘッダの下に自前のバー(シミュ: 出撃 / 海域 / 敵艦 / 計算設定、任務、設定)を描く。
  poi が v3 のプラグインを読み込むまではタブが 2 行になるが、どれも動く。
  古い Web UI(古いセルフホストのサーバ)を v3 のプラグインで開くと、`view` に応答がない。
  その場合 Web UI は自前のサイドバーを残し、プラグインの Web のタブでは切り替わらない。
  v1 の `hostViews` / `host` / `open-view` は v2 で削除した。

- **データ**:
  プラグインが送るのは、Web UI が読むもの(shared/fleet/poiImport.ts、カタログ、マップのタブ)だけである。
  - `info.basic.api_level`
  - `{api_id, api_name, api_ship}` の形にした `info.fleets[]`
  - 艦のインスタンスごとの `api_id, api_ship_id,
  api_lv, api_slot, api_onslot, api_slotnum, api_slot_ex, api_kyouka, api_maxhp, api_nowhp, api_karyoku, api_raisou,
  api_taiku, api_soukou, api_kaihi, api_taisen, api_sakuteki, api_lucky, api_leng, api_soku, api_cond`
  - 装備のインスタンスごとの `api_id, api_slotitem_id, api_level, api_alv`
  - 基地航空隊 `info.airbase[]` を `{api_area_id, api_rid,
  api_name, api_action_kind, api_plane_info[]: {api_squadron_id, api_state, api_slotid, api_count, api_max_count}}` の形にしたもの
  - poi の `sortie.combinedFlag` を、メッセージの `combinedFlag`(0〜3)として
  - `const.{$ships, $equips, $shipTypes,
  $equipTypes, $mapareas}`
  - 任務 タブのための `quests` = `{list, active, records}`

  `quests` の中身は次の 3 つである。
  1 つ目は、プラグインの reducer(`src/quests/reducer.ts`。プラグインの `reducer` としてエクスポートし、poi が `state.ext["poi-plugin-kc-sim"]._` に保持する)がこのセッションで最後に見た 全て の任務リスト(`api_no`、`api_state`、`api_type`、`api_progress_flag` だけ)。
  2 つ目は、同じ 4 フィールドに絞った poi の `info.quests.activeQuests`。
  3 つ目は、poi の進捗カウンタ `info.quests.records`(サブゴールごとの `{key, description, count, required}`)に、poi が追跡しない任務のプラグイン独自のカウント(同じ形で `source: "kcsim"` 付き。「任務の進捗」を参照)を加えたもの。
  それ以外のデータ(提督の名前とメンバー ID。各艦隊の `api_member_id` を含む。基地の距離、遠征、資源、任務のタイトル)は、プラグインが送信前に捨て、Web UI も受信時にもう一度捨てる。
  データは iframe にだけ渡り、Web UI はこれをアップロードしない。
- **オリジンと送信元**:
  プラグインはサーバ URL のオリジンを宛先にして送り、そのオリジンを持つ iframe のウィンドウからのメッセージだけを受け付ける。
  poi のウィンドウモードでは、プラグインのコードは poi のメインウィンドウで動き、ビューはプラグインのウィンドウにポータルで描かれる。
  そのため iframe から見た送信元はメインウィンドウ、つまり `window.parent.opener` になる。
  Web UI が受け付けるのは、`window.parent` か `window.parent.opener` から届いた、オリジンが `file://`(poi のプラグインのウィンドウ)のメッセージだけである。
  `null` も受け付けているが、これは実際の poi が報告する文字列を確認できるまでの措置で、確認できたら外す。
  `http://localhost` は Web UI の開発サーバに限る。
  そのうえで形を検証し、未知の種別は無視する。
  Web UI から親へ送るメッセージはカウント以外のデータを含まず、宛先には `*` を使う(`file://` のページはオリジンで宛先を指定できない)。
- **バージョン**:
  `v` は送信側のプロトコルバージョンである。
  任意のフィールドを足すだけならバージョンは変えず、それ以外の変更では上げる。
  Web UI は一括でデプロイされ、少なくともプラグインの 1 リリースの間は、1 つ前のバージョンも受け付ける。
  受け付けないバージョンのプラグインには「プラグインを更新してください」と表示する。
  Web UI のほうが新しいときは、プラグインが短い通知を表示する。
- **プリセットの移行**:
  旧プラグイン内 UI が保存したプリセット(プラグインの localStorage の `kcsim:preset:*`)は、サーバのオリジンごとに 1 回送る。
  Web UI はそれを上書きも重複もせずに取り込み(`importJSON(…, { skipExisting })`)、`persisted` 付きで確認を返す。
  `persisted` は、プリセットのストアが本物の localStorage かどうかを示す(iframe のストレージがブロックされているとメモリにフォールバックする)。
  プラグインは `persisted: true` の確認を受け取ったときだけ `kcsim:presetsMigrated:<origin>` を記録し、そうでなければ次の `ready` でもう一度送る。
  プラグイン側のコピーは消さない。
- **iframe**:
  `sandbox="allow-scripts allow-same-origin"`(フォーム、ポップアップ、ダウンロード、トップレベルのナビゲーションは不可。Web UI はどれも使わない)、`allow="clipboard-write"`(コピーボタン用)、`referrerpolicy="no-referrer"` を指定する。

## poi についての注意

- **ウィンドウモード限定**:
  poi 12 のメインウィンドウは `nodeIntegration` と `nodeIntegrationInSubFrames` を有効にして動く(`app.ts`)ので、そこに置いた iframe は Node.js を使えてしまう。
  一方、プラグインのウィンドウ(ウィンドウモード)は `nodeIntegration: false` で作られ(`lib/webcontent-utils.ts`)、poi が `window.isWindowMode = true` を設定する。
  プラグインが Web UI を埋め込むのは、ビューを載せるウィンドウが `isWindowMode === true` で、Node.js(`require` / `process.versions.node`)がないときだけである。
  ほかのウィンドウでは埋め込みを拒否する。
  poi のタブモードでは、代わりに「ウィンドウモードで開いてください」と表示する。
  観測ログ、送信設定、資源 はどちらのモードでも動く。
- **ポータル**:
  プラグインのビューで `window` / `document` を扱うコードは、ビュー自身のウィンドウ(`element.ownerDocument.defaultView`)を使う必要がある。
  グローバルの `window` は poi のメインウィンドウを指すためである。
  ダイアログ(`web/src/ui/Modal.tsx`)は、Esc とフォーカスの処理でこれに従っている。
- **CSP**:
  poi のプラグインのウィンドウの CSP は `script-src https://www.google-analytics.com 'self' file://* 'unsafe-inline'` で、`default-src` / `frame-src` がないので、https の iframe はブロックされない。
  埋め込む側の CSP は、オリジンの異なるフレームの中には及ばない(Web UI のワーカーと wasm は自分のオリジンから読み込む)。
- **ストレージ**:
  poi の中の Web UI は、プリセットと設定を、poi から見た自分のオリジンのストレージに保存する(ブラウザで同じサイトを開いたときとは別)。
  サーバ URL を変えたり、サーバを別のホストに移したりすると、移った先では空のストレージから始まる。
  プリセットはプラグインの古いコピーからもう一度移行されるが、それより新しいプリセットは JSON の書き出しと取り込みで移す必要がある。
- 観測の捕捉(`startCapture`)は、poi のメインウィンドウで `pluginDidLoad` から始まる。
  `game.response` を監視し、戦闘を IndexedDB(`kcsim`)に、資源のスナップショットを IndexedDB(`kcsim-resources`)に保存する。
- スタイルは `.kcsim` にスコープし、プラグインのビューがマウントされている間だけ注入する。

## 検証メモ

開発ページを使い、ブラウザで埋め込みの経路を確認した。
確認したのは、メインウィンドウの送信元が `parent.opener` として見えること、`isWindowMode` 付きの子ウィンドウへのポータル、ポータルに描いたログドロワーでの Esc、タブモードでの拒否である。
実際の poi のウィンドウでは、iframe に Node.js がないこと、poi が報告するオリジンの文字列(`file://` か `null`)、iframe のストレージが poi の再起動後も残ることをまだ確認していない。
以前の確認は、2026-10-22 に poi 12.0.1(macOS)で、隔離したプロファイル(`--user-data-dir`)を使い、ログインせずに行った。

資源の履歴は、poi 12 の reducer(`views/redux/info/resources.js`。インストール済みのアプリから読んだ)と、イベント前の dispatch の順序に照らして、`bun dev/resources-smoke.ts` で確認した。
ログイン済みの poi ではまだ確認していない。

npm パッケージ 0.4.0 は、`npm pack` の出力を `npm install --global-style` で空のプレフィックスにインストールし、poi 12.0.1 自身の `.es` 用 babel フック(`app.asar` の `babel-hook.js`)で読み込んで、poi の React 18.3.1 と react-dom/server で描画した。
新しい localStorage での 送信設定(通知が表示され、自動送信がオン)も含めて、React のエラーは出なかった。
ビューは、ブラウザの React 18.3.1 でも一通りクリックして確認した。
バンドルは React 19 専用の API を使っていない(lucide-react のアイコンは `forwardRef` を使い、react-redux 9 は React 18 の要素シンボルを選ぶ)。
