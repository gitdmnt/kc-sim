// Quest master data (docs/DATA_SOURCES.md §14) -> `quests` rows for GET /api/v1/quests (docs/API.md "Quests").
//   KC3Kai src/data/quests_meta.json        `unlock` lists (MIT): the maintained prerequisite graph
//   KC3Kai/kc3-translations data/jp/quests  code, name, description, memo (MIT)
//   kcwikizh/kcwiki-quest-data data.json    structured requirements and its own `prerequisite` lists (MIT, stale)
//   shared/quest/overrides.json             hand-authored conditions / prerequisites / rewards (ours; ./questOverrides.ts)
import * as z from "zod";
import type { QuestEdgeSource, QuestEntry, QuestRequirement } from "../../shared/quest/types";
import type { QuestOverride } from "./questOverrides";

/** `sources.key` of the three files in the order above, then the overrides (scripts/ingest-quests.ts, GET /quests). */
export const QUEST_SOURCE_KEYS = ["kc3kai-quests-meta", "kc3-translations-quests", "kcwiki-quest-data", "quest-overrides"] as const;

/** `{"101": {"unlock": [102], ...}}`; non-numeric keys (the trailing "EoF&RemarksOfDataFormat") are skipped. */
export const kc3QuestMeta = z.record(z.string(), z.unknown());
const kc3MetaEntry = z.object({ unlock: z.array(z.number().int()).optional() }).loose();

export const kc3QuestTranslations = z.record(z.string(), z.unknown());
const kc3TlEntry = z.object({
  code: z.string().optional(), name: z.string().optional(), desc: z.string().optional(), memo: z.string().optional(),
}).loose();

export const kcwikiQuest = z.object({
  game_id: z.number().int().positive(),
  wiki_id: z.string().optional(),
  name: z.string().optional(),
  detail: z.string().optional(),
  prerequisite: z.array(z.number().int()).default([]),
  requirements: z.object({ category: z.string() }).loose().optional(),
}).loose();
export const kcwikiQuestData = z.array(kcwikiQuest);

const API_NO = /^[1-9]\d*$/;
const text = (s: string | undefined): string | null => {
  const t = s?.replace(/<br\s*\/?>/gi, "\n").trim();
  return t ? t : null;
};

export interface QuestMergeInput {
  kc3Meta: z.infer<typeof kc3QuestMeta>;
  kc3Jp: z.infer<typeof kc3QuestTranslations>;
  kcwiki: z.infer<typeof kcwikiQuestData>;
  /** Validated hand-authored overrides (parseQuestOverrides); they win over the three files */
  overrides?: QuestOverride[];
}

export interface QuestMergeStats {
  quests: number;
  edges: number;
  kc3Edges: number;
  kcwikiEdges: number;
  bothEdges: number;
  withRequirements: number;
  /** Edges whose prerequisite id is not a known quest (kept; the client shows them as unknown quests) */
  danglingEdges: number;
  /** Quests an override changed, and how many of them got their requirements / prerequisites / rewards from it */
  overridden: number;
  overriddenRequirements: number;
  overriddenPre: number;
  overriddenRewards: number;
  /** Overrides for quests none of the three files has */
  overrideOnly: number;
}

/**
 * Union of the three files keyed by api_no. A prerequisite edge is kept when either source asserts it, with the
 * sources listed (KC3 is maintained but sometimes names only the last unlocking quest; kcwiki has more AND-edges for
 * quests up to 2022 but stopped there). Text comes from kc3-translations, else kcwiki. An override then replaces the
 * fields it sets: `pre` is the complete edge list (edges it omits are dropped), `requirements` / `rewards` / text
 * replace wholesale; `override` records the source page and the replaced fields.
 */
export function mergeQuests(input: QuestMergeInput): { quests: QuestEntry[]; stats: QuestMergeStats } {
  const meta = new Map<number, z.infer<typeof kc3MetaEntry>>();
  for (const [k, v] of Object.entries(input.kc3Meta)) {
    if (!API_NO.test(k)) continue;
    const e = kc3MetaEntry.safeParse(v);
    if (e.success) meta.set(Number(k), e.data);
  }
  const tl = new Map<number, z.infer<typeof kc3TlEntry>>();
  for (const [k, v] of Object.entries(input.kc3Jp)) {
    if (!API_NO.test(k)) continue;
    const e = kc3TlEntry.safeParse(v);
    if (e.success) tl.set(Number(k), e.data);
  }
  const kw = new Map(input.kcwiki.map((q) => [q.game_id, q]));

  const ids = new Set<number>([...meta.keys(), ...tl.keys(), ...kw.keys()]);
  const pre = new Map<number, Map<number, Set<QuestEdgeSource>>>();
  const addEdge = (to: number, from: number, src: QuestEdgeSource) => {
    if (to === from) return;
    let m = pre.get(to);
    if (!m) pre.set(to, (m = new Map()));
    let s = m.get(from);
    if (!s) m.set(from, (s = new Set()));
    s.add(src);
  };
  for (const [from, e] of meta) for (const to of e.unlock ?? []) addEdge(to, from, "kc3");
  for (const q of kw.values()) for (const from of q.prerequisite) addEdge(q.game_id, from, "kcwiki");
  for (const to of pre.keys()) ids.add(to);
  const overrides = new Map((input.overrides ?? []).map((o) => [o.id, o]));
  const upstreamIds = new Set(ids);
  for (const o of overrides.values()) ids.add(o.id);

  const stats: QuestMergeStats = {
    quests: 0, edges: 0, kc3Edges: 0, kcwikiEdges: 0, bothEdges: 0, withRequirements: 0, danglingEdges: 0,
    overridden: 0, overriddenRequirements: 0, overriddenPre: 0, overriddenRewards: 0, overrideOnly: 0,
  };
  const quests = [...ids].sort((a, b) => a - b).map((id): QuestEntry => {
    const t = tl.get(id);
    const k = kw.get(id);
    const o = overrides.get(id);
    const upstreamEdges = pre.get(id) ?? new Map<number, Set<QuestEdgeSource>>();
    if (o?.pre) {
      const listed = new Map(o.pre.map((from) => [from, new Set<QuestEdgeSource>([...(upstreamEdges.get(from) ?? []), "override"])]));
      upstreamEdges.clear();
      for (const [from, src] of listed) if (from !== id) upstreamEdges.set(from, src);
    }
    const edges = [...upstreamEdges]
      .sort(([a], [b]) => a - b)
      .map(([from, src]) => ({ id: from, src: (["kc3", "kcwiki", "override"] as const).filter((s) => src.has(s)) }));
    for (const e of edges) {
      stats.edges++;
      if (e.src.includes("kc3")) stats.kc3Edges++;
      if (e.src.includes("kcwiki")) stats.kcwikiEdges++;
      if (e.src.includes("kc3") && e.src.includes("kcwiki")) stats.bothEdges++;
      if (!ids.has(e.id)) stats.danglingEdges++;
    }
    const requirements = (o?.requirements as QuestRequirement | undefined) ?? (k?.requirements as QuestRequirement | undefined) ?? null;
    if (requirements) stats.withRequirements++;
    const entry: QuestEntry = {
      id,
      // the override's code is for readers of the file; it only fills in quests the upstream lacks a code for
      code: t?.code?.trim() || k?.wiki_id?.trim() || o?.code?.trim() || null,
      name: text(o?.name) ?? text(t?.name) ?? text(k?.name),
      detail: text(o?.detail) ?? text(t?.desc) ?? text(k?.detail),
      memo: text(t?.memo),
      pre: edges,
      requirements,
      rewards: o?.rewards ?? null,
      override: null,
    };
    if (o) {
      const fields: string[] = (["name", "detail", "pre", "requirements", "rewards"] as const).filter((f) => o[f] !== undefined);
      if (o.code && !t?.code?.trim() && !k?.wiki_id?.trim()) fields.unshift("code");
      entry.override = { source: o.source, fields, ...(o.note ? { note: o.note } : {}), ...(o.author ? { author: o.author } : {}), ...(o.date ? { date: o.date } : {}) };
      stats.overridden++;
      if (o.requirements) stats.overriddenRequirements++;
      if (o.pre) stats.overriddenPre++;
      if (o.rewards) stats.overriddenRewards++;
      if (!upstreamIds.has(id)) stats.overrideOnly++;
    }
    return entry;
  });
  stats.quests = quests.length;
  return { quests, stats };
}
