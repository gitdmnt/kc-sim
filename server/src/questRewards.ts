// Quest rewards from the upstream files (private notes DATA_SOURCES §14), merged in ./quests.ts after the overrides:
//   antest1/kcanotify-gamedata files/quests-jp.json (MIT, maintained): resources and a one-line reward text per quest
//   kcwikizh/kcwiki-quest-data data.json (MIT, stale since 2022–23): reward_fuel.. and structured reward_other
//   KC3Kai/kc3-translations data/jp/quests.json `memo` (MIT): the "[獲]" lines, items only (no resources)
import * as z from "zod";
import type { QuestRewardItem, QuestRewards } from "../../shared/quest/types";

/** `{"101": {code, name, desc, memo?, rewards: "駆逐艦「白雪」", resources: [[fuel, ammo, steel, baux], [bucket, burner, devmat, screw]]}}` */
export const kcanotifyQuests = z.record(z.string(), z.unknown());
export const kcanotifyEntry = z.object({
  rewards: z.string().optional(),
  resources: z.array(z.array(z.number().int().min(0))).optional(),
}).loose();

const AMOUNT = /^(.+?)\s*[×x](\d+)$/;
/** 二回選択報酬：[a、b][c、d] / 選択報酬：[a、b] */
const CHOICE_HEAD = /^(?:二回)?選択報酬[：:]\s*(.*)$/;

/** "開発資材×2" / "倉橋 x1" / "装備運用枠+12" (no amount) */
export const parseRewardItem = (s: string, choice?: number): QuestRewardItem | null => {
  const t = s.trim();
  if (!t) return null;
  const m = AMOUNT.exec(t);
  const name = (m ? m[1]! : t).trim();
  const amount = m ? Number(m[2]) : 1;
  return { name, ...(amount > 1 ? { amount } : {}), ...(choice ? { choice } : {}) };
};

const pushAll = (out: QuestRewardItem[], parts: string[], choice?: number) => {
  for (const p of parts) {
    const i = parseRewardItem(p, choice);
    if (i) out.push(i);
  }
};

/** Splits on `sep` outside [...] brackets. */
const splitTop = (s: string, sep: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
};

/**
 * kcanotify's reward line: fixed items separated by ", ", then optional "選択報酬：[a、b、c]" (one group) or
 * "二回選択報酬：[a、b][c、d]" (two groups). Choice groups are numbered 1, 2, … in order.
 */
export const parseKcanotifyRewardText = (text: string): QuestRewardItem[] => {
  const out: QuestRewardItem[] = [];
  let choice = 0;
  for (const seg of splitTop(text, ",")) {
    const head = CHOICE_HEAD.exec(seg.trim());
    if (!head) {
      pushAll(out, [seg]);
      continue;
    }
    const groups = [...head[1]!.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!);
    for (const g of groups.length ? groups : [head[1]!]) pushAll(out, g.split("、"), ++choice);
  }
  return out;
};

/**
 * The items of a KC3 memo's "[獲]" section: fixed items as "a、bx2" lines; after a "選択報酬：" / "二回選択報酬：" line
 * every indented (全角スペース) line is one choice group. Stops at the next "※" note. null without "[獲]".
 */
export const parseKc3MemoRewards = (memo: string | null | undefined): QuestRewardItem[] | null => {
  const at = memo?.indexOf("[獲]") ?? -1;
  if (!memo || at < 0) return null;
  const out: QuestRewardItem[] = [];
  let choice = 0;
  let inChoice = false;
  for (const raw of memo.slice(at + 3).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("※")) break;
    if (!line) continue;
    const head = CHOICE_HEAD.exec(line);
    if (head) {
      inChoice = true;
      if (head[1]) pushAll(out, head[1].split("、"), ++choice);
    } else if (inChoice && /^[\u3000\s]/.test(raw)) pushAll(out, line.split("、"), ++choice);
    else {
      inChoice = false;
      pushAll(out, line.split("、"));
    }
  }
  return out.length ? out : null;
};

/** kcanotify entry -> rewards; null when it has neither resources nor a reward line. */
export const kcanotifyRewards = (e: z.infer<typeof kcanotifyEntry>): QuestRewards | null => {
  const res = e.resources?.[0];
  const items = e.rewards ? parseKcanotifyRewardText(e.rewards) : [];
  if (!(res?.length === 4) && items.length === 0) return null;
  return { ...(res?.length === 4 ? { resources: res } : {}), ...(items.length ? { items } : {}), src: "kcanotify" };
};

const kcwikiItem = z.object({ name: z.string().min(1), amount: z.number().int().optional() });
const kcwikiOther = z.union([z.object({ choices: z.array(kcwikiItem) }), kcwikiItem]);
const kcwikiRewardFields = z.object({
  reward_fuel: z.number().int().optional(),
  reward_ammo: z.number().int().optional(),
  reward_steel: z.number().int().optional(),
  reward_bauxite: z.number().int().optional(),
  reward_other: z.array(kcwikiOther).optional(),
}).loose();

/** kcwiki `reward_*`: each `{choices: [...]}` entry is one choice group. null when the entry has no reward fields. */
export const kcwikiRewards = (q: unknown): QuestRewards | null => {
  const r = kcwikiRewardFields.safeParse(q);
  if (!r.success) return null;
  const f = r.data;
  const res = [f.reward_fuel, f.reward_ammo, f.reward_steel, f.reward_bauxite];
  const items: QuestRewardItem[] = [];
  let choice = 0;
  const add = (i: z.infer<typeof kcwikiItem>, c?: number) =>
    items.push({ name: i.name, ...(i.amount && i.amount > 1 ? { amount: i.amount } : {}), ...(c ? { choice: c } : {}) });
  for (const o of f.reward_other ?? []) {
    if ("choices" in o) {
      choice++;
      for (const i of o.choices) add(i, choice);
    } else add(o);
  }
  const hasRes = res.every((x) => x !== undefined);
  if (!hasRes && items.length === 0) return null;
  return { ...(hasRes ? { resources: res as number[] } : {}), ...(items.length ? { items } : {}), src: "kcwiki" };
};
