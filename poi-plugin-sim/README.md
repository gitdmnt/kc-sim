# poi-plugin-sim

[poi](https://github.com/poooi/poi) 用の艦これ出撃シミュレータープラグイン(ウィンドウモードのプラグイン)。npm では
[`poi-plugin-kc-sim`](https://www.npmjs.com/package/poi-plugin-kc-sim) として公開している。シミュレーターの UI 自体は
[`../web`](../web) の Web アプリで、データ API の Cloudflare Worker が配信する。このプラグインの役割は次のとおり。

- プレイ中の戦闘とマップのパケットを**捕捉**し(poi がプラグインを読み込んだときに始まり、ウィンドウは要らない)、
  IndexedDB(`kcsim`)に保存する。
- 自動送信 がオンのとき(新規インストールではオン)、それらをサーバに**アップロード**する(各戦闘結果のあとと
  母港に戻ったときにデバウンスし、定期的な再試行と指数バックオフを行う。リクエストは 60 秒に 1 回、インストールごとの bearer トークン)。
- **観測ログ**、**送信設定**(サーバ URL、自動送信、登録)、**資源**(資源の履歴)のビューを表示する。
- 提督の**資源を記録する**(燃料 / 弾薬 / 鋼材 / ボーキと 4 種の資材)。変化するたびに IndexedDB
  (`kcsim-resources`)に保存する。このマシンに保管し、アップロードも iframe への送信もしない。
- poi のトラッカーが扱わない**一回限りの任務の進捗を数える**。同梱した手書きの任務条件に基づく
  (IndexedDB `kcsim-quests`)。
- poi の艦隊、マスターデータ、任務の状態を `postMessage` で渡して、iframe に **Web UI を埋め込む**(シミュレーター)。
  クロームはプラグインが 1 つだけ描く(下記「ナビゲーション」)。

## ナビゲーション

VS Code 風で、Web UI のモデル(`../web/src/app/nav.tsx`)とコンポーネント(`../web/src/ui/AppChrome.tsx`)を使う。
左のアクティビティバーが機能を切り替え(グローバル)、上の行が選択中の機能のビューを切り替える(ローカル)。右端に
バージョンを表示する。

| 機能(バー) | ビュー(上の行) | 描画するもの |
|---|---|---|
| シミュ | 出撃 / 海域 / 敵艦 / 観測ログ / 送信設定 / 計算設定 | 観測ログ、送信設定: プラグイン。それ以外: iframe |
| 任務 | (タイトルのみ) | iframe |
| 資源 | 推移 / 増減 (イベント) / 増減 (日別)(期間、提督、資源のトグルはビューの中に残る) | プラグイン |
| 設定(歯車、最下部) | (タイトルのみ): Web UI のアプリ全体の設定(サンプルデータ、プリセットの削除、データキャッシュ、リセット) | iframe |

- iframe はマウントしたままで(プラグインのビューを表示している間は隠す)、最後に選んだ Web のビューを表示する。プラグインが
  それを `view` で送り、Web UI は自前のバーを描かない。Web UI が自分で行う移動(海域 →「出撃シミュ」)は
  `view` として戻ってきて、プラグインの上の行で 出撃 を選択する。
- 現在のビューはプラグインの localStorage に保存する(`kcsim:view`。キーと ID は Web UI と同じ)。機能を切り替えると、
  セッション内でその機能の最後のビューに戻る。
- macOS: プラグインのウィンドウにタイトルバーはない。信号機のボタン(約 80 × 28 px。120 × 42 px を確保)は左上にあり、poi は上端に
  23 px の `-webkit-app-region: drag` の帯を重ねる。上の行はウィンドウ全体にわたり、タブは 192 px 内側から始まる
  (`pl-48`、バージョンは `pr-12`)。アクティビティバーは上の行の下から始まる(y = 61 px。行の高さは 60 px、バーの幅は 96 px)。上の行のタブは `no-drag` で、
  行のそれ以外の部分は引き続きウィンドウをドラッグする。ほかの OS では、バーの上の角にアプリのアイコンを表示する。

Rust のエンジンは `../sim-core`(Web UI が使う)にあり、サーバは `../server` にある。

## ビルド

必要なもの: [bun](https://bun.sh) ≥ 1.3。

```sh
cd poi-plugin-sim
bun install
bun run build        # prebuild: (cd ../web && bun install --frozen-lockfile)
```

プラグインのビューとクロームは、Web UI の部品とスタイルシート(`../web/src`)を使う。その Tailwind CSS は
`../web/node_modules` から解決されるので、`bun run build` と `bun run dev` は先に `../web` の依存を入れる
(`bun run deps:web`)。`../web/src` から import した `react`、`react-dom`、`lucide-react` は、このパッケージのコピーに解決される
(`vite.config.ts` の `resolve.dedupe`。React が 2 つあるとフックが壊れる)。

出力(`../poi-plugin-sim-build`。npm パッケージ `poi-plugin-kc-sim`): `index.es`、`package.json`(生成される。下記を参照)、
`views/index.js`(捕捉、アップロード、プラグインのビューと、`.kcsim` にスコープした CSS)、`i18n/`、`README.md`
(`README.npm.md` のコピー。ユーザー向けの npm ページ)、`LICENSE`、`THIRD_PARTY_NOTICES`(`views/index.js` が
束ねるもの: lucide-react、react-redux、use-sync-external-store、Tailwind の CSS、kcwiki-quest-data と
kancolle-replay のデータ。束ねるパッケージが変わったら更新する)。wasm もワーカーもない。シミュレーションは Web UI で動く。
React と ReactDOM は外部扱いである。poi 12 が React 18.3 を提供するので、プラグインのコードは React 19 専用の API を使ってはならない。

出力の `package.json` は、`package.build.json` に、このディレクトリの `package.json` の `version` を加えたものである(バージョンを
保持する唯一の場所。vite.config.ts の `packageJson()`)。パッケージ名は、poi がプラグインの reducer に使うキーでもある
(`state.ext["poi-plugin-kc-sim"]`。`src/quests/reducer.ts` が `package.build.json` から読む)。

そのほかのコマンド: `bun test`、`bunx tsc --noEmit`、`bun run dev`(下記)、`bun run screenshots`(2 つの開発サーバを起動し、
`docs/screenshots/{05-log-list,06-log-detail,08-plugin-upload,19-plugin-embedded,20-plugin-resources,21-plugin-resources-delta,22-plugin-quests}.png`
を 1024x600 で書き出す。poi の macOS のドラッグ帯とウィンドウボタンは左上に重ねて描く。資源のスクリーンショットは、`dev/resourcesSeed.ts` が生成した
履歴を使い、任務のスクリーンショットはローカルのデータ API の任務を使う。API に 4-2 の敵編成がないとき(KCNav の取り込みをしていないローカル D1)は、マップのデータを静的な
バンドルから取る。次の場合は失敗する: どの機能とビューでも、バーと上の行が定位置に留まらない、ウィンドウボタンの下にタブがある、ドラッグ帯の中のタブが
`no-drag` でない、プラグインのタブが iframe のビューを切り替えない、iframe 自身の移動が戻ってこない、埋め込んだ Web UI がバーを描く、
4-2 の出撃がボスに到達しない、または 1280x800 / 1200x710 / 1024x600 でいずれかのページ(プラグインのものも iframe のものも)がスクロールする)、`bun dev/resources-smoke.ts`
(poi と同じように、台本どおりの API 応答の列を `startCapture` に流し、記録されたもの、再起動、
間引きを出力する)。

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

`bun run dev` は vite で `dev/index.html` を配信し、poi のウィンドウモードを再現する。ページが poi のメインウィンドウの役を担い
(プラグインの React ツリーと `postMessage` の呼び出しはそこで動く)、`window.open` で開く子ウィンドウに
`createPortal` でビューを描く。子ウィンドウには `isWindowMode = true` が立つ(localhost のポップアップを許可するか、
ページのボタンを使う)。`?mode=tab` は、poi のタブモードと同じように、ビューをページ自体に描く(iframe は拒否される)。poi の状態は
Web UI のサンプルの状態である。iframe は `?server=`(既定は `http://localhost:5173/`。つまり
`cd ../web && bun run dev`)を開く。

## poi へのインストール

ユーザー: poi → 設定 → プラグイン で、npm から `poi-plugin-kc-sim` をインストールする(poi がプラグインのディレクトリで `npm install` を実行する)。

開発: poi は `~/Library/Application Support/poi/plugins/node_modules/poi-plugin-*` からプラグインを読み込む(macOS。
Windows は `%APPDATA%\poi\plugins\node_modules`、Linux は `~/.config/poi/plugins/node_modules`)。npm のリリース版の代わりに
ビルドの出力をリンクする(先に poi を終了する。`file:` 依存にすると、poi 自身の `npm install` で削除されずに済む)。

```sh
cd "$HOME/Library/Application Support/poi/plugins"
cp package.json package.json.bak            # back up first
npm install /ABSOLUTE/PATH/TO/poi-plugin-sim-build   # adds "poi-plugin-kc-sim": "file:…" and the symlink node_modules/poi-plugin-kc-sim
```

poi を再起動する。プラグインは、プラグインドロワー(プラグインタブの隣のシェブロン)に「シミュ」(ほかの
言語では *kc-sim*)として現れる。再ビルドするとその場で更新される(poi を再起動するか、プラグインのリロードを使う)。リンクと npm の
リリース版を両方入れておかない。同じパッケージだからである(`npm uninstall poi-plugin-kc-sim` でどちらも削除できる)。

**旧リンク名(0.4.0 より前)。** 以前の手順で用意したプラグインのディレクトリには、
`"poi-plugin-sim-build": "file:…/poi-plugin-sim-build"` とシンボリックリンク `node_modules/poi-plugin-sim-build` がある。
それでも動く(poi は名前をリンク先の `package.json`、現在は `poi-plugin-kc-sim` から取る)が、poi の更新ボタンと削除ボタンは
`node_modules/poi-plugin-kc-sim` に対して働き、リンクの隣に npm のリリース版をインストールしてしまう。poi を
終了した状態で、npm のリリース版か、新しい名前のリンクに切り替える(観測ログ、設定、資源の履歴は
poi のストレージにあり、保持される)。

```sh
cd "$HOME/Library/Application Support/poi/plugins" && npm uninstall poi-plugin-sim-build && npm install poi-plugin-kc-sim
# or, to keep loading the local build:
cd "$HOME/Library/Application Support/poi/plugins" && npm uninstall poi-plugin-sim-build && npm install /ABSOLUTE/PATH/TO/poi-plugin-sim-build
```

サーバ URL(既定は `https://kc-sim.udama.net/`)は シミュ → 送信設定 で設定する。iframe はそれを開き、
観測はそのオリジンにアップロードされる。受け付けるのは `https://` の URL と、`localhost`、`127.0.0.1`、`[::1]` の `http://` だけである
(ローカルの `cd ../server && bun run dev` は、`cd ../web && bun run build` のあと `http://127.0.0.1:8787/` になる)。

**自動送信**(`src/settings.ts`): 新規インストール(poi の localStorage に `kcsim:` のキーがない)は、自動送信が
**オン**で始まる。オンの間、送信設定 は(閉じる を押すまで)通知を表示する。内容は、アップロードに含まれるもの(各出撃のマップパケット、生の
戦闘と戦闘結果の応答、出撃艦隊、司令部レベル。提督の名前、ID、演習、資源、
任務は含まない。`capture/db.ts` の `uploadPending`)、サーバのオリジン、オフにするボタンである。閉じる は通知を隠す
(`uploadNoticeClosed`)。観測ログへの捕捉は、この設定に依存しない。保存済みの `kcsim:plugin` は
`autoUpload` を保つ。

**旧プラグイン内 UI からのアップグレード**(初回起動、`src/settings.ts`): 旧 API のベースが
旧本番 Worker(`kc-sim-data.lumpoler.workers.dev`)または新しいホスト(`kc-sim.udama.net`)だったアップグレードは、
自動送信の設定を保ち、登録は新しいオリジンに移す(同じ D1 なので、クライアント ID は有効なまま)。
それ以外のアップグレード(旧既定の `http://127.0.0.1:8787`、またはほかのサーバ)は、自動送信を**オフ**で始める。ユーザーがオンにしない限り、
本番には何も送られない。旧 UI のキー(`kcsim:settings`、`kcsim:cache:*`、
`kcsim:tab`、`kcsim:map`、`kcsim:selectedPreset`)は削除する。プリセット、登録、アップロードの状態は保持する。

## リリース(npm)

1. `package.json` の `version` を上げる(semver。バージョンを保持する唯一の場所)。プラグインの埋め込み
   プロトコルのバージョンを変えるリリースの前に、Web UI がそのバージョンを受け付けるようにする(「Web UI の埋め込み」→ バージョン)。
2. `bun install && bunx tsc --noEmit && bun test && bun run build`。
3. パッケージを確認する: `cd ../poi-plugin-sim-build && npm pack --dry-run` が、`LICENSE`、`README.md`、
   `THIRD_PARTY_NOTICES`、`i18n/ja-JP.json`、`index.es`、`package.json`、`views/index.js` だけを、新しいバージョンで列挙する。
4. `../poi-plugin-sim-build` で `npm publish --access public`(パッケージの所有者として `npm login` が要る)。
5. コミットして `v<version>` のタグを付け(`git tag v0.4.0`)、`--tags` でプッシュする。poi は、インストール済みのユーザーに
   npm の `latest` タグから更新を提示する。

## 資源の履歴(資源)

- **タイミング:** `startCapture` は資源も監視する。poi は `game.response` を発火する前に redux ストアを更新する
  (`views/env-parts/data-resolver`)ので、プラグインは応答のたびに `info.resources`(poi の順序: 燃料、弾薬、
  鋼材、ボーキ、高速建造材、高速修復材、開発資材、改修資材)と `info.basic.api_member_id` を読む。poi が
  追跡するものをすべて含む: `api_port/port`、`api_get_member/material`、`api_req_hokyu/charge`、`api_req_kousyou/*`(開発・建造・解体・
  廃棄・改修、高速建造)、`api_req_nyukyo/start` / `speedchange`、`api_req_air_corps/supply` / `set_plane`。
- **内容:** スナップショット `{admiral, t, v[8], event, via?}` は、その提督の直前のスナップショットと値が異なるときだけ記録する
  (再起動をまたいでも同じ。最後のものは IndexedDB から読み戻す)。`event` は変化を起こした API のパスである。一部の
  API は、ゲーム内では資源を動かすが、poi のストアでは次の同期まで反映されない(遠征 `api_req_mission/result`、任務
  `api_req_quest/clearitemget`、`api_itemget` を伴う資源マス `api_req_map/start|next`、改造、アイテム使用)。これらは
  次のスナップショットの `via` に列挙し(たとえば「母港 (遠征・任務)」)、全体の同期(母港 / 資材)で
  変化がなければ捨てる。
- **保存:** IndexedDB `kcsim-resources`(観測ログとは別なので、そちらを消してもここには影響しない)。
  スナップショットごとに 1 行で、`[admiral, t]` を索引にする。提督 ID ごとに履歴が 1 つ。間引きは、セッションの最初のスナップショットのあと、
  そして 1 日ごとに行う。直近 7 日間は全件を残し(イベントごとの 増減)、90 日までは 1 時間ごとの最後のスナップショット、
  それより古いものは現地時間の 1 日ごとの最後のものを残す。残したスナップショットは、吸収した数(`merged`)を持つ。よく遊ぶプレイヤーでも、
  数千行に、1 年あたり 365 行を加えた程度に収まる。
- **ビュー:** 推移(階段状の線。燃料・弾薬・鋼材・ボーキと資材は別の目盛り)、増減 (イベント)、増減 (日別)、
  期間は 1日 / 1週 / 1月 / 全期間、資源ごとのトグル(現在値と、期間内の変化を表示する)、履歴が複数あるときの
  提督の選択。スクロールするのは 増減 のテーブルだけで、ページはスクロールしない。履歴がないとき(poi の外、または最初の母港の前)は
  「資源の記録がありません」と表示する。

## 任務の進捗(任務カウンタ)

poi が数えるのは、`quest_goal.cson` の任務(約 130 件。実質的に周期的なもの)だけである。それ以外については、`startCapture` が
`game.response` のたびに `QuestCounter`(`src/quests/counter.ts`)も実行する。

- **対象の任務:** poi の `info.quests.activeQuests` で進行中(`api_state` 2)で、poi の `records` になく、同梱の
  `shared/quest/overrides.json` に数えられるサブゴールがあるもの(`shared/quest/progress.ts` の `questGoals`。スキーマと
  意味は docs/QUEST_OVERRIDES.md)。新しいオーバーライドは、次のプラグインのビルドでプレイヤーに届く。
- **イベント:** `api_req_map/start` はマップ、出撃艦隊(艦を順に、マスターの stype / ctype / レベルつき)、
  ゲージ番号を覚える。`start` / `next` はセルと、それがボスかどうか(`api_event_id` 5 または `api_bosscell_no`)を覚える。
  `api_req_sortie|combined_battle/battleresult` は、そこでのランクを数える。`api_req_practice/battle` + `battle_result`。
  `api_req_mission/result`(成功または大成功。ミッション ID は艦隊の `api_mission` から、なければ名前で)。
  `api_req_kousyou/createitem`(試行)、`createship`、`destroyitem2` / `destroyship`、`api_req_kaisou/powerup`
  (廃棄 / 消費したアイテムは、直前の応答の状態から探す。poi がイベントの前にそれらを取り除くため)、
  `remodel_slot`、`api_req_kaisou/remodeling`(新しい姿 = 古い姿の `api_aftershipid`)、`hokyu/charge`、
  `nyukyo/start`。連合艦隊は主力艦隊で確認する。
- **リセット:** 任務のカウントは、`api_req_quest/clearitemget` のとき、および 全て の任務リスト(タブ 0)にもうその任務が
  載らなくなったときに削除する。「本日中」のゴールは 05:00 JST に再開する。
- **保存:** IndexedDB `kcsim-quests`。提督ごとに 1 行(`{admiral, quests: {id: {goalKey: {count, day?}}}}`)。
  保存は `BroadcastChannel`(`kcsim-quest-progress`)で通知し、プラグインのウィンドウが読み直す。
- **Web UI へ:** パネル(`src/poi/index.tsx`)は、保存されたカウントを、数えられる受注中のすべての任務のゴールに変換し(`countedGoals`)、
  ブリッジは、poi に記録がないところに、それを `source: "kcsim"` つきで `quests.records` に統合する。

## Web UI の埋め込み

プロトコル: [`shared/embed/protocol.ts`](../shared/embed/protocol.ts)。すべてのメッセージは
`{ src: "kcsim", v, type, ...fields }` の形である。

| 方向 | `type` | フィールド | タイミング |
|---|---|---|---|
| Web → プラグイン | `ready` | `v` = Web UI のプロトコルバージョン | Web UI が待ち受けを始めたとき |
| プラグイン → Web | `view` | `view`: `sortie` / `map` / `enemy` / `sim-settings` / `quests` / `settings`(`WEB_VIEWS`) | `ready` のたびに最初に。そのあと、ユーザーがプラグインのクロームで別の Web ビューを選んだとき |
| プラグイン → Web | `state` | `info`、`const?`、`combinedFlag?`、`quests?` | `ready` のたびに(`const` つきで)。そのあと下記の部分が変わったとき(まとめて 250 ms)。`const` は変わったときだけ |
| プラグイン → Web | `presets` | `json`(`kcsim-presets` の書き出し) | `ready` のあと、そのオリジンで 1 回確認されるまで |
| Web → プラグイン | `presets-ack` | `imported`、`skipped`、`persisted` | 取り込みのあと |
| Web → プラグイン | `view` | `view`(上と同じ) | Web UI が自分で移動したとき(海域 →「戦闘シミュ」/「出撃シミュ」)。v3 以降のプラグインにだけ送る。送り返さない |

- **1 つのクローム(v3):** プラグインが唯一のバーを描く(上の「ナビゲーション」)。どの機能とビューでも同じ場所で、
  iframe のビューは `view` で選ぶ。Web UI は、v3 以降のメッセージが届いたあと(と、最初のメッセージを待つ間)は、自前のバーを隠す。
  プラグイン自身のビュー(観測ログ、送信設定、資源)は送らない。
- **互換性:** Web UI は一度にデプロイされ、v1〜v3 を受け付ける。v2 のプラグイン(0.2.x: シミュレーション / 観測ログ / 資源 / 送信設定の
  ヘッダ行が 1 つ)の中では、そのヘッダの下に自前のバーを描く(シミュ: 出撃 / 海域 / 敵艦 /
  計算設定、任務、設定)。poi が v3 のプラグインを読み込むまでは、タブが 2 行になるが、すべて動く。古い Web UI(古い
  セルフホストのサーバ)の前に置いた v3 のプラグインは、`view` に反応が返らない。Web UI は自前のサイドバーを保ち、
  プラグインの Web のタブはそれを切り替えない。v2 は v1 の `hostViews` / `host` / `open-view` を削除した。

- **データ:** プラグインが送るのは、Web UI が読むものだけである(shared/fleet/poiImport.ts、カタログ、マップのタブ)。
  `info.basic.api_level`、`{api_id, api_name, api_ship}` としての `info.fleets[]`、艦のインスタンスごとの `api_id, api_ship_id,
  api_lv, api_slot, api_onslot, api_slotnum, api_slot_ex, api_kyouka, api_maxhp, api_nowhp, api_karyoku, api_raisou,
  api_taiku, api_soukou, api_kaihi, api_taisen, api_sakuteki, api_lucky, api_leng, api_soku, api_cond`、装備のインスタンスごとの
  `api_id, api_slotitem_id, api_level, api_alv`、基地航空隊 `info.airbase[]` を `{api_area_id, api_rid,
  api_name, api_action_kind, api_plane_info[]: {api_squadron_id, api_state, api_slotid, api_count, api_max_count}}` として、
  poi の `sortie.combinedFlag` をメッセージの `combinedFlag`(0〜3)として、`const.{$ships, $equips, $shipTypes,
  $equipTypes, $mapareas}`、そして 任務 タブのための `quests` = `{list, active, records}`。`quests` の中身は、プラグインの reducer
  (`src/quests/reducer.ts`。プラグインの `reducer` としてエクスポートし、poi が `state.ext["poi-plugin-kc-sim"]._` に保持する)が
  このセッションで見た最後の 全て の任務リスト(`api_no`、`api_state`、`api_type`、`api_progress_flag` だけ)、
  同じ 4 つのフィールドに絞った poi の `info.quests.activeQuests`、poi の進捗カウンタ `info.quests.records`
  (サブゴールごとの `{key, description, count, required}`)に、poi が追跡しない任務についてのプラグイン自身のカウント(同じ
  形、`source: "kcsim"`。「任務の進捗」を参照)を加えたものである。それ以外(提督の名前とメンバー ID。各艦隊の
  `api_member_id` を含む。基地の距離、遠征、資源、任務のタイトル)は、プラグインが送信前に、Web UI が受信時にもう一度、捨てる。
  データは iframe にだけ渡り、ほかには渡らない。Web UI はこれをアップロードしない。
- **オリジンと送信元:** プラグインは、サーバ URL のオリジンを宛先にして送り、そのオリジンを持つ
  iframe のウィンドウからのメッセージだけを受け付ける。poi のウィンドウモードでは、プラグインのコードは poi のメインウィンドウで動き、ビューは
  プラグインのウィンドウにポータルで描かれる。そのため iframe から見える送信元はメインウィンドウ、つまり `window.parent.opener` である。
  したがって Web UI は、`window.parent` または `window.parent.opener` からの、オリジンが `file://` のメッセージだけを受け付け(poi の
  プラグインのウィンドウ。`null` は、実際の poi がどの文字列を報告するか確認できるまで引き続き受け付けるが、確認できたら外す。
  `http://localhost` は Web UI の開発サーバのみ)、形を検証し、未知の種別は無視する。親への自分のメッセージは、
  カウント以外のデータを持たず、宛先に `*` を使う(`file://` のページはオリジンで宛先を指定できない)。
- **バージョン:** `v` は送信側のプロトコルバージョンである。任意のフィールドを足してもバージョンは変わらず、それ以外の変更では上げる。
  Web UI は一度にデプロイされ、少なくとも 1 回のプラグインのリリースの間は、1 つ前のバージョンを受け付け続ける。受け付けない
  プラグインのバージョンには「プラグインを更新してください」と表示する。Web UI のほうが新しいときは、プラグインが短い通知を表示する。
- **プリセットの移行:** 旧プラグイン内 UI が保存したプリセット(プラグインの localStorage の `kcsim:preset:*`)は、サーバのオリジンごとに
  1 回送る。Web UI は上書きも重複もせずに取り込み(`importJSON(…, { skipExisting })`)、
  `persisted` つきで確認を返す。これは、プリセットのストアが本物の localStorage かどうか(iframe のストレージが
  ブロックされているときはメモリにフォールバックする)を示す。`persisted: true` の確認だけが、プラグインに `kcsim:presetsMigrated:<origin>` を記録させる。
  そうでなければ、次の `ready` でプリセットをもう一度送る。プラグイン側のコピーは残す。
- **iframe:** `sandbox="allow-scripts allow-same-origin"`(フォーム、ポップアップ、ダウンロード、トップのナビゲーションは不可。Web UI は
  どれも使わない)、`allow="clipboard-write"`(コピーボタン)、`referrerpolicy="no-referrer"`。

## poi についての注意

- **ウィンドウモードのみ。** poi 12 のメインウィンドウは `nodeIntegration` と `nodeIntegrationInSubFrames` つきで動く
  (`app.ts`)ので、そこの iframe は Node.js を使えてしまう。プラグインのウィンドウ(ウィンドウモード)は
  `nodeIntegration: false` で作られ(`lib/webcontent-utils.ts`)、poi はそれらに `window.isWindowMode = true` を設定する。プラグインは、
  ビューを載せるウィンドウが `isWindowMode === true` で Node.js(`require` /
  `process.versions.node`)がないときだけ Web UI を埋め込む。ほかのウィンドウは拒否する。poi のタブモードでは、代わりに「ウィンドウモードで開いてください」を
  表示する。観測ログ、送信設定、資源 は、どちらのモードでも動く。
- **ポータル。** プラグインのビューから `window` / `document` に触れるコードは、ビュー自身のウィンドウ
  (`element.ownerDocument.defaultView`)を使わなければならない。グローバルの `window` は poi のメインウィンドウである。ダイアログ(`web/src/ui/Modal.tsx`)は、
  Esc とフォーカスについてこれを行っている。
- **CSP。** poi のプラグインのウィンドウは `script-src https://www.google-analytics.com 'self' file://* 'unsafe-inline'` を持ち、
  `default-src` / `frame-src` はないので、https の iframe はブロックされない。埋め込む側の CSP は、
  オリジンの異なるフレームの中には適用されない(Web UI のワーカーと wasm は、自分のオリジンから読み込まれる)。
- **ストレージ。** poi の中の Web UI は、プリセットと設定を、poi から見た自分のオリジンのストレージに保存する
  (ブラウザで同じサイトを開いたものとは別)。サーバ URL を変える、またはサーバを別のホストに移すと、そこでは
  空のストレージから始まる(プリセットは、プラグインの古いコピーから再び移行される。新しいプリセットは
  JSON の書き出し/取り込みで移す必要がある)。
- 観測の捕捉(`startCapture`)は、poi のメインウィンドウで `pluginDidLoad` から始まり、`game.response` を監視し、
  戦闘を IndexedDB(`kcsim`)に、資源のスナップショットを IndexedDB(`kcsim-resources`)に保存する。
- スタイルは `.kcsim` にスコープされ、プラグインのビューがマウントされている間だけ注入される。

## 検証メモ

埋め込みの経路(`parent.opener` として見えるメインウィンドウの送信元、`isWindowMode` つきの子ウィンドウへのポータル、
ポータルに描いたログドロワーでの Esc、タブモードでの拒否)は、開発ページを使ってブラウザで確認した。
実際の poi のウィンドウでは、まだ確認していない: iframe に Node.js がないこと、poi が報告するオリジンの文字列(`file://` か
`null`)、iframe のストレージが poi の再起動後も残ること。
以前、poi 12.0.1(macOS)で、2026-10-22 に、隔離したプロファイル(`--user-data-dir`)を使い、ログインせずに確認した。
資源の履歴は、poi 12 の reducer(`views/redux/info/resources.js`。インストール済みのアプリから読んだ)と、そのイベント前の
dispatch の順序に照らして、`bun dev/resources-smoke.ts` で確認した。ログイン済みの poi ではまだ確認していない。
npm パッケージ 0.4.0(`npm pack` の出力を `npm install --global-style` で空のプレフィックスにインストールしたもの)は、
poi 12.0.1 自身の `.es` の babel フック(`app.asar` の `babel-hook.js`)で読み込み、poi の React 18.3.1 と
react-dom/server で描画した。新しい localStorage での 送信設定(通知が表示され、自動送信がオン)も含み、React の
エラーは出なかった。ビューは、ブラウザの React 18.3.1 でも一通りクリックして確認した。バンドルは React 19 専用の API を使わない
(lucide-react のアイコンは `forwardRef` を使い、react-redux 9 は React 18 の要素シンボルを選ぶ)。
