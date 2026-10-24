/**
 * 資源の記録の動作確認 (poi 無し): `bun dev/resources-smoke.ts`。
 *
 * poi と同じ順番 (redux を更新 → game.response を発火) で API の応答を流し、startCapture が記録した内容を表示する。
 * redux の資源の更新は poi 12 の views/redux/info/resources.js (+ resources-cross-slice) の該当部分を写したもの。
 * 続けて再起動 (stopCapture → startCapture) をまたいだ重複判定と、古い記録の間引きも確かめる。IndexedDB は fake-indexeddb。
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { ObservationDb } from "../src/capture/db";
import { startCapture, stopCapture } from "../src/capture/plugin";
import { DAY, ResourceDb, onResourceRecorded } from "../src/resources";
import { eventDeltas, snapshotLabel } from "../src/resources/view";

type Material = { api_id: number; api_value: number }[];
/** この確認で流す応答の形 (使う項目だけ) */
type Body = { api_basic?: Record<string, unknown>; api_material?: Material | number[] } | Material;
const ADMIRAL = 8_000_123;
const state = { info: { basic: {} as Record<string, unknown>, resources: [] as number[] } };

/** poi の reducer の資源の部分 (この確認で流す API だけ) */
const reduce = (path: string, body: Body, postBody: Record<string, string>) => {
  const r = state.info.resources;
  const merge = (arr: number[]) => arr.forEach((n, i) => (r[i] = n));
  const values = (m: Material) => m.map((x) => x.api_value);
  const b = Array.isArray(body) ? {} : body;
  switch (path) {
    case "api_port/port":
      state.info.basic = b.api_basic ?? {};
      merge(values(b.api_material as Material));
      break;
    case "api_get_member/material":
      merge(values(body as Material));
      break;
    case "api_req_hokyu/charge":
    case "api_req_kousyou/createitem":
      merge(b.api_material as number[]);
      break;
    case "api_req_kousyou/createship":
      [0, 1, 2, 3].forEach((i) => (r[i] -= Number(postBody[`api_item${i + 1}`])));
      r[6] -= Number(postBody.api_item5);
      break;
    case "api_req_nyukyo/speedchange":
      r[5] -= 1;
      break;
  }
  state.info.resources = [...r];
};

const material = (v: number[]) => v.map((api_value, i) => ({ api_id: i + 1, api_value }));
const port = (v: number[]) => ({ api_basic: { api_member_id: ADMIRAL, api_level: 120 }, api_material: material(v) });

const factory = new IDBFactory();
let notified = 0;
let waiters: (() => void)[] = [];
onResourceRecorded(() => {
  notified++;
  const wake = waiters;
  waiters = [];
  wake.forEach((w) => w());
});
const waitRecords = async (n: number) => {
  while (notified < n) {
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push(resolve);
    await promise;
  }
};

const target = new EventTarget();
const start = () =>
  startCapture({
    db: new ObservationDb(factory),
    getState: () => state,
    target,
    autoUpload: false,
    resources: new ResourceDb(factory),
  });
// 間引きは記録時の Date.now() で古さを測るので、応答の時刻も今から始める
let clock = Date.now() - 2 * 3600_000;
const fire = (path: string, body: unknown = {}, postBody: Record<string, string> = {}) => {
  clock += 5 * 60_000;
  reduce(path, body as Body, postBody);
  target.dispatchEvent(new CustomEvent("game.response", { detail: { method: "POST", path: `/kcsapi/${path}`, body, postBody, time: clock } }));
};

start();
const base = [150_000, 160_000, 170_000, 80_000, 1_000, 2_000, 3_000, 100];
fire("api_start2/getData"); // 資源はまだ無い → 記録しない
fire("api_get_member/require_info");
fire("api_port/port", port(base)); // 1
fire("api_get_member/deck"); // 変化なし
fire("api_req_hokyu/charge", { api_material: [149_700, 159_600, 170_000, 79_950] }); // 2
fire("api_req_kousyou/createitem", { api_material: [149_690, 159_510, 169_910, 79_920, 1_000, 2_000, 2_999, 100] }); // 3
fire("api_req_kousyou/createship", { }, { api_item1: "30", api_item2: "30", api_item3: "30", api_item4: "30", api_item5: "1", api_highspeed: "0" }); // 4
fire("api_req_nyukyo/speedchange", {}, { api_ndock_id: "1" }); // 5
fire("api_req_mission/result", { api_get_material: [400, 400, 0, 0] }); // poi は資源を変えない
fire("api_req_quest/clearitemget", { api_material: [100, 100, 100, 100] }); // 同上
fire("api_port/port", port([150_160, 160_380, 170_011, 79_991, 1_000, 1_999, 2_998, 100])); // 6: 遠征・任務の分
fire("api_port/port", port([150_160, 160_380, 170_011, 79_991, 1_000, 1_999, 2_998, 100])); // 変化なし
await waitRecords(6);

const resources = new ResourceDb(factory);
const show = async (title: string) => {
  const rows = await resources.list(String(ADMIRAL));
  console.log(`\n${title}: ${rows.length} snapshots`);
  console.table(
    rows.map((s) => ({
      time: new Date(s.t).toISOString().slice(5, 16),
      event: s.event,
      via: s.via?.join(",") ?? "",
      label: snapshotLabel(s),
      燃料: s.v[0],
      弾薬: s.v[1],
      鋼材: s.v[2],
      ボーキ: s.v[3],
      建造材: s.v[4],
      修復材: s.v[5],
      開発資材: s.v[6],
      merged: s.merged ?? "",
    }))
  );
  return rows;
};
const first = await show("after the simulated session");
console.log("\nper-event deltas (newest first):");
console.table(eventDeltas(first, 0, Infinity).map((d) => ({ label: d.label, 燃料: d.d[0], 弾薬: d.d[1], 鋼材: d.d[2], ボーキ: d.d[3], 修復材: d.d[5], 開発資材: d.d[6] })));

// 再起動: 記録をやめ、同じ DB で開き直す。同じ値の母港は記録せず、変わった値だけ記録する
stopCapture();
start();
fire("api_port/port", port([150_160, 160_380, 170_011, 79_991, 1_000, 1_999, 2_998, 100]));
fire("api_get_member/material", material([150_190, 160_410, 170_041, 80_001, 1_000, 1_999, 2_998, 100])); // 7: 自然回復
await waitRecords(7);
const afterRestart = await show("after a restart (same values not duplicated)");

// 間引き: 120 日前から 20 分おきの古い記録 (別の提督) を入れ、次の記録で間引かれることを確かめる
stopCapture();
const OLD = "999";
const old = new ResourceDb(factory);
let n = 0;
for (let t = clock - 120 * DAY; t < clock - DAY; t += 20 * 60_000) {
  await old.add({ admiral: OLD, t, v: [100_000 + n, 100_000, 100_000, 50_000, 0, 0, 0, 0], event: "api_port/port" });
  n++;
}
state.info.basic = { api_member_id: OLD };
start();
fire("api_get_member/material", material([200_000, 100_000, 100_000, 50_000, 0, 0, 0, 0])); // 8
await waitRecords(8);
const thinned = await old.list(OLD);
const span = (from: number, to: number) => thinned.filter((s) => s.t >= clock - to * DAY && s.t < clock - from * DAY).length;
console.log(
  `\nthinning (admiral ${OLD}): ${n + 1} → ${thinned.length} snapshots;`,
  `last 7 days ${span(0, 7)}, 7–90 days ${span(7, 90)} (≤ 1/hour), older ${span(90, 121)} (≤ 1/day);`,
  `merged total ${thinned.reduce((a, s) => a + (s.merged ?? 0), 0)}`
);
stopCapture();

const ok =
  first.length === 6 &&
  first[5].event === "api_port/port" &&
  first[5].via?.join() === "api_req_mission/result,api_req_quest/clearitemget" &&
  afterRestart.length === 7 &&
  afterRestart[6].event === "api_get_member/material" &&
  span(7, 90) <= 83 * 24 + 1 &&
  span(90, 121) <= 31;
console.log(ok ? "\nOK" : "\nFAILED");
process.exit(ok ? 0 : 1);
