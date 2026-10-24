// Quest master data (docs/DATA_SOURCES.md §14) -> `quests` rows for GET /api/v1/quests (docs/API.md "Quests").
//   KC3Kai src/data/quests_meta.json        `unlock` lists (MIT): the maintained prerequisite graph
//   KC3Kai/kc3-translations data/jp/quests  code, name, description, memo (MIT)
//   kcwikizh/kcwiki-quest-data data.json    structured requirements and its own `prerequisite` lists (MIT, stale)
import * as z from "zod";
import type { QuestEdgeSource, QuestEntry, QuestRequirement } from "../../shared/quest/types";

/** `sources.key` of the three files, in the order above (scripts/ingest-quests.ts, GET /quests). */
export const QUEST_SOURCE_KEYS = ["kc3kai-quests-meta", "kc3-translations-quests", "kcwiki-quest-data"] as const;

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
}

/**
 * Union of the three files keyed by api_no. A prerequisite edge is kept when either source asserts it, with the
 * sources listed (KC3 is maintained but sometimes names only the last unlocking quest; kcwiki has more AND-edges for
 * quests up to 2022 but stopped there). Text comes from kc3-translations, else kcwiki.
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

  const stats: QuestMergeStats = { quests: 0, edges: 0, kc3Edges: 0, kcwikiEdges: 0, bothEdges: 0, withRequirements: 0, danglingEdges: 0 };
  const quests = [...ids].sort((a, b) => a - b).map((id): QuestEntry => {
    const t = tl.get(id);
    const k = kw.get(id);
    const edges = [...(pre.get(id) ?? new Map<number, Set<QuestEdgeSource>>())]
      .sort(([a], [b]) => a - b)
      .map(([from, src]) => ({ id: from, src: (["kc3", "kcwiki"] as const).filter((s) => src.has(s)) }));
    for (const e of edges) {
      stats.edges++;
      if (e.src.includes("kc3")) stats.kc3Edges++;
      if (e.src.includes("kcwiki")) stats.kcwikiEdges++;
      if (e.src.length === 2) stats.bothEdges++;
      if (!ids.has(e.id)) stats.danglingEdges++;
    }
    if (k?.requirements) stats.withRequirements++;
    return {
      id,
      code: t?.code?.trim() || k?.wiki_id?.trim() || null,
      name: text(t?.name) ?? text(k?.name),
      detail: text(t?.desc) ?? text(k?.detail),
      memo: text(t?.memo),
      pre: edges,
      requirements: (k?.requirements as QuestRequirement | undefined) ?? null,
    };
  });
  stats.quests = quests.length;
  return { quests, stats };
}
