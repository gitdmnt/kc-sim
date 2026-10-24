/**
 * 開発用: それらしい資源の記録 (決まった乱数で再現可能)。スクリーンショット (scripts/screenshots.ts) が
 * 開発用ページの IndexedDB に入れて 資源 タブを撮る。実際の記録と同じく間引いてから返す。
 */
import { HOUR, thinSnapshots } from "../src/resources";
import type { ResourceSnapshot } from "../src/resources";

export const seedResourceHistory = (now: number, days = 45, admiral = "1"): ResourceSnapshot[] => {
  let seed = 20261024;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const int = (lo: number, hi: number) => Math.floor(lo + rnd() * (hi - lo));
  // 燃料, 弾薬, 鋼材, ボーキ, 高速建造材, 高速修復材, 開発資材, 改修資材
  const v = [182_000, 215_000, 241_000, 96_000, 1_200, 2_400, 3_100, 180];
  const out: ResourceSnapshot[] = [];
  let t = now - days * 24 * HOUR;
  const push = (event: string, via?: string[]) => out.push({ admiral, t, v: [...v], event, ...(via ? { via } : {}) });
  push("api_port/port");
  // 最後の 2 週はイベント: 出撃が多く、燃料・弾薬・ボーキが減っていく
  const eventFrom = now - 14 * 24 * HOUR;
  while (t < now - 20 * 60_000) {
    t += int(8, 75) * 60_000;
    const h = new Date(t).getHours();
    if (h >= 2 && h < 8) {
      // 寝ている間の遠征
      t += 6 * HOUR;
      v[0] += int(1_500, 3_000);
      v[1] += int(1_500, 3_000);
      v[2] += int(800, 2_000);
      v[3] += int(300, 900);
      v[5] += int(0, 4);
      push("api_port/port", ["api_req_mission/result"]);
      continue;
    }
    const r = t >= eventFrom ? rnd() * 0.8 : 0.1 + rnd() * 0.9;
    if (r < 0.4) {
      v[0] -= int(300, t >= eventFrom ? 1_400 : 600);
      v[1] -= int(400, t >= eventFrom ? 1_600 : 700);
      v[3] -= int(0, t >= eventFrom ? 400 : 150);
      push("api_req_hokyu/charge");
    } else if (r < 0.62) {
      v[0] += int(300, 900);
      v[1] += int(200, 700);
      v[2] += int(0, 500);
      v[3] += int(0, 250);
      if (rnd() < 0.3) v[5] += 1;
      push("api_port/port", ["api_req_mission/result"]);
    } else if (r < 0.74) {
      v[0] -= int(20, 300);
      v[2] -= int(50, 700);
      if (rnd() < 0.5) {
        v[5] -= 1;
        push("api_req_nyukyo/speedchange");
      } else {
        push("api_req_nyukyo/start");
      }
    } else if (r < 0.84) {
      v[0] -= 10;
      v[1] -= 90;
      v[2] -= 90;
      v[3] -= 30;
      v[6] -= 1;
      push("api_req_kousyou/createitem");
    } else if (r < 0.92) {
      v[0] += 500;
      v[1] += 500;
      v[2] += 500;
      v[3] += 200;
      v[6] += 2;
      push("api_port/port", ["api_req_quest/clearitemget"]);
    } else if (r < 0.97) {
      v[2] -= int(100, 400);
      v[6] -= int(5, 20);
      v[7] -= int(1, 4);
      push("api_req_kousyou/remodel_slot");
    } else {
      v[0] -= 300;
      v[1] -= 30;
      v[2] -= 400;
      v[3] -= 30;
      v[6] -= 20;
      v[4] -= 1;
      push("api_req_kousyou/createship");
    }
  }
  return thinSnapshots(out, now).keep;
};
