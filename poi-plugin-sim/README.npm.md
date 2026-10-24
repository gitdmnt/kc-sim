# poi-plugin-kc-sim

艦これの出撃をシミュレートする [poi](https://github.com/poooi/poi) のプラグインです (プラグイン一覧での名前は「シミュ」)。

- **シミュ**: 海域と艦隊を選ぶと出撃を 10,000 回計算し、ボス到達・S勝利・大破撤退の割合、マスごとの到達率、資源の消費を出します。海域のマップと敵編成、深海棲艦のステータスも見られます。
- **任務**: 任務の一覧と前提任務のツリー、必要な艦娘・装備。poi が数えない単発任務の一部は、このプラグインが進捗を数えます。
- **資源**: 燃料・弾薬・鋼材・ボーキと資材の推移と増減。
- **観測ログ**: 出撃した海域・マス・戦闘の記録。

poi の艦隊・装備・任務の状態はそのまま読み込まれます。計算結果は近似で、ゲームの結果と一致する保証はありません。

## 入れ方

poi の 設定 → プラグイン で `poi-plugin-kc-sim` を入力してインストールし、poi を再起動します。

**ウィンドウモードで開いてください。** タブ表示では、シミュと任務の画面は出ません (観測ログ・送信設定・資源は使えます)。

## 通信と送信されるデータ

シミュと任務の画面は https://kc-sim.udama.net/ (シミュ → 送信設定 のサーバ URL) から読み込みます。
poi の艦隊・装備・任務の状態はその画面に渡すだけで、送信しません。

観測ログの自動送信は**初期設定でオン**です。同じサーバに次のものを送ります。止めるには、シミュ → 送信設定 の「自動送信をオフにする」ボタンか「観測ログを自動送信」のチェックを外します。

- 出撃した海域・マス・経路 (ゲームの `api_req_map/start`・`next` の応答)
- 戦闘と戦闘結果の応答 (敵編成、ドロップ、司令部の Lv・経験値を含む)
- 出撃した艦隊 (艦・Lv・装備・ステータス・燃料・弾薬) と司令部 Lv

提督名・提督 ID・ログイン情報、演習、資源と任務の記録は送りません。送信をオフにしても、観測ログ・資源・任務の進捗はこの PC に記録します。

## データの出典

- 艦娘・装備・海域のマスターデータ: ゲームの `api_start2` ([Tibowl/api_start2](https://github.com/Tibowl/api_start2) 経由)
- 深海棲艦のステータス、装備ボーナス、イベント特効: [KC3Kai/kancolle-replay](https://github.com/KC3Kai/kancolle-replay)
- 海域の辺と座標、任務の前提: [KC3Kai/KC3Kai](https://github.com/KC3Kai/KC3Kai)、任務の文章: [KC3Kai/kc3-translations](https://github.com/KC3Kai/kc3-translations)
- 任務の達成条件: [kcwikizh/kcwiki-quest-data](https://github.com/kcwikizh/kcwiki-quest-data)、任務の報酬: [antest1/kcanotify-gamedata](https://github.com/antest1/kcanotify-gamedata)
- イベント海域のマスの種類: [kcwiki/kancolle-data](https://github.com/kcwiki/kancolle-data)
- 敵編成と出現率、マスの種類: [KCNav / TsunDB](https://tsunkit.net/nav/)
- ルート分岐の条件: [x-20a 羅針盤シミュ](https://x-20a.github.io/compass) を参考に作成
- 一部の任務の条件と前提: [ぜかましねっと](https://zekamashi.net/) を参考に作成
- 戦闘式: kancolle-replay と [en.kancollewiki.net](https://en.kancollewiki.net/) の記述をもとに実装

## ライセンス

MIT ([LICENSE](LICENSE))。同梱しているライブラリとデータのライセンスは [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) にあります。

非公式のファンツールです。ゲームの運営とは関係ありません。
