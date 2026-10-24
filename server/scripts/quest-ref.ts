// Helpers for hand-authoring server/data/quest-overrides.json (docs/QUEST_OVERRIDES.md). Nothing here is shipped.
//
//   bun scripts/quest-ref.ts fetch <url>        zekamashi page -> server/.tmp/zekamashi/ (cached; never re-fetched)
//   bun scripts/quest-ref.ts text <url>         readable text of a cached (else fetched) page, for reading only
//   bun scripts/quest-ref.ts find <id|code|name...> zekamashi articles (HTML sitemap titles) containing the quest name
//   bun scripts/quest-ref.ts ship <name...>     master ship ids (with remodels) / ship types by name
//   bun scripts/quest-ref.ts equip <name...>    master equipment ids by name
//   bun scripts/quest-ref.ts quest <id|code|name...> merged upstream entry + override of a quest (name: substring)
//   bun scripts/quest-ref.ts cells <W-M> <letter...> game cell ids (api_no) entering a node letter, for `cells`
//   bun scripts/quest-ref.ts missing [kind]     quests with no structured conditions (kind: once|limited|y|q|m|w|d)
//   bun scripts/quest-ref.ts check              validates the override file against the master data
//
// zekamashi.net is fetched politely: one request at a time, at least FETCH_GAP_MS apart (across invocations, through
// a timestamp file), each page cached forever under server/.tmp/zekamashi. Their text stays there (gitignored); the
// override file only holds our own structured data and the source URL.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetchGithub, type GithubFile } from "./lib/fetch";
import { kc3QuestMeta, kc3QuestTranslations, kcwikiQuestData, mergeQuests } from "../src/quests";
import { parseQuestOverrides, QUEST_OVERRIDES_PATH } from "../src/questOverrides";
import { nameKey } from "../../shared/quest/tree";

const TMP = join(import.meta.dir, "..", ".tmp");
const ZEKAMASHI = join(TMP, "zekamashi");
const UPSTREAM = join(TMP, "quests");
const FETCH_GAP_MS = 3000;
const UA = "kc-sim quest reference (personal project; sequential, cached; https://github.com/gitdmnt)";

const cachePath = (url: string): string => {
  const u = new URL(url);
  if (u.hostname !== "zekamashi.net") throw new Error(`not a zekamashi.net URL: ${url}`);
  const slug = (u.pathname.replace(/^\/+|\/+$/g, "") || "index").replace(/[^\w.-]+/g, "_");
  return join(ZEKAMASHI, slug.endsWith(".xml") ? slug : `${slug}.html`);
};

/** The page from the cache, else one polite request (waits until FETCH_GAP_MS after the previous one). */
export async function zekamashi(url: string): Promise<string> {
  const path = cachePath(url);
  const cached = Bun.file(path);
  if (await cached.exists()) return cached.text();
  await mkdir(ZEKAMASHI, { recursive: true });
  const stamp = Bun.file(join(ZEKAMASHI, ".last-fetch"));
  const last = (await stamp.exists()) ? Number(await stamp.text()) : 0;
  const wait = last + FETCH_GAP_MS - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  await Bun.write(stamp, String(Date.now()));
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const body = await res.text();
  await Bun.write(path, body);
  return body;
}

const decode = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#8217;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/** The article body as plain lines (tables flattened to " | " rows). */
export const pageText = (html: string): string => {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
  const body = /<div class="entry-content[^"]*"[^>]*>([\s\S]*?)<div class="(?:sns-share|article-footer|entry-footer)/i.exec(html)?.[1]
    ?? /<article[\s\S]*?<\/article>/i.exec(html)?.[0] ?? html;
  const text = body
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|table)>/gi, "\n")
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "[$1]")
    .replace(/<[^>]+>/g, "");
  return `${decode(title)}\n\n${decode(text).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n")}`;
};

/** Every article of zekamashi's HTML sitemap (/sitemaps/: one cached page lists all posts with their titles). */
async function articles(): Promise<{ url: string; title: string }[]> {
  const html = await zekamashi("https://zekamashi.net/sitemaps/");
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<a href="(https:\/\/zekamashi\.net\/[^"]+)"[^>]*>([^<]+)<\/a>/g)) out.set(m[1]!, decode(m[2]!));
  return [...out].map(([url, title]) => ({ url, title }));
}

/** Article candidates for a quest name: titles containing the name (NFKC, spaces ignored). */
export async function findArticles(name: string): Promise<{ url: string; title: string }[]> {
  const key = nameKey(name);
  return (await articles()).filter((a) => nameKey(a.title).includes(key));
}

async function cachedJson(name: string, file: GithubFile): Promise<unknown> {
  const f = Bun.file(join(UPSTREAM, name));
  if (await f.exists()) return f.json();
  const { text } = await fetchGithub(file);
  await mkdir(UPSTREAM, { recursive: true });
  await Bun.write(f, text);
  return JSON.parse(text);
}

interface Master {
  ships: { api_id: number; api_name: string; api_stype: number; api_ctype?: number; api_aftershipid?: string }[];
  equips: { api_id: number; api_name: string; api_type: number[] }[];
  stypes: { api_id: number; api_name: string }[];
}
async function master(): Promise<Master> {
  const j = (await cachedJson("start2.json", { owner: "Tibowl", repo: "api_start2", ref: "master", path: "start2.json" })) as Record<string, unknown>;
  const d = (j.api_data ?? j) as Record<string, unknown>;
  return {
    ships: (d.api_mst_ship as Master["ships"]).filter((s) => s.api_id <= 1500),
    equips: (d.api_mst_slotitem as Master["equips"]).filter((e) => e.api_id <= 1500),
    stypes: d.api_mst_stype as Master["stypes"],
  };
}

async function upstream() {
  const [meta, jp, kw] = await Promise.all([
    cachedJson("kc3-meta.json", { owner: "KC3Kai", repo: "KC3Kai", ref: "master", path: "src/data/quests_meta.json" }),
    cachedJson("kc3-jp.json", { owner: "KC3Kai", repo: "kc3-translations", ref: "master", path: "data/jp/quests.json" }),
    cachedJson("kcwiki-data.json", { owner: "kcwikizh", repo: "kcwiki-quest-data", ref: "gh-pages", path: "data.json" }),
  ]);
  return mergeQuests({ kc3Meta: kc3QuestMeta.parse(meta), kc3Jp: kc3QuestTranslations.parse(jp), kcwiki: kcwikiQuestData.parse(kw) }).quests;
}

const kindOf = (code: string | null) => (!code ? "?" : /^\d{4}/.test(code) ? "limited" : (/^[A-Z]([dwmqy])\d/.exec(code)?.[1] ?? "once"));

async function main(cmd: string | undefined, args: string[]) {
  switch (cmd) {
    case "fetch":
      for (const url of args) console.log(`${cachePath(url)} (${(await zekamashi(url)).length} chars)`);
      return;
    case "text":
      for (const url of args) console.log(pageText(await zekamashi(url)));
      return;
    case "find": {
      const quests = await upstream();
      for (const a of args) {
        const q = quests.find((x) => String(x.id) === a || x.code === a);
        const name = q?.name ?? a;
        const hits = await findArticles(name);
        console.log(`${q ? `${q.id} ${q.code} ` : ""}${name}: ${hits.length ? "" : "no article title contains the name"}`);
        for (const h of hits) console.log(`  ${h.url}  ${h.title}`);
      }
      return;
    }
    case "ship": {
      const m = await master();
      const byId = new Map(m.ships.map((s) => [s.api_id, s]));
      const before = new Map<number, number>();
      for (const s of m.ships) {
        const next = Number(s.api_aftershipid ?? 0);
        if (next > 0 && !before.has(next)) before.set(next, s.api_id);
      }
      /** Every form reachable over api_aftershipid from `id` (remodel loops stop at a repeat). */
      const after = (id: number): number[] => {
        const out: number[] = [];
        for (let x = id; x > 0 && !out.includes(x); x = Number(byId.get(x)?.api_aftershipid ?? 0)) out.push(x);
        return out;
      };
      for (const name of args) {
        const st = m.stypes.find((s) => s.api_name === name);
        if (st) console.log(`stype ${name}: ${st.api_id}`);
        const hits = m.ships.filter((s) => nameKey(s.api_name) === nameKey(name));
        const near = hits.length ? hits : m.ships.filter((s) => nameKey(s.api_name).includes(nameKey(name)));
        for (const s of near) console.log(`${s.api_id}\t${s.api_name}\tstype ${s.api_stype}\tctype ${s.api_ctype}\t→ ${s.api_aftershipid ?? "-"}`);
        for (const s of hits) {
          let base = s.api_id;
          for (const seen = new Set<number>(); before.has(base) && !seen.has(base); base = before.get(base)!) seen.add(base);
          const fmt = (l: number[]) => `${JSON.stringify(l)}  ${l.map((i) => byId.get(i)?.api_name).join(" / ")}`;
          console.log(`  this form and later: ${fmt(after(s.api_id))}`);
          console.log(`  every form:          ${fmt(after(base))}`);
        }
        if (!st && near.length === 0) console.log(`${name}: no match`);
      }
      return;
    }
    case "equip": {
      const m = await master();
      for (const name of args) {
        const hits = m.equips.filter((e) => nameKey(e.api_name).includes(nameKey(name)));
        for (const e of hits) console.log(`${e.api_id}\t${e.api_name}\ttype ${e.api_type.join("/")}`);
        if (hits.length === 0) console.log(`${name}: no match`);
      }
      return;
    }
    case "quest": {
      const quests = await upstream();
      const overrides = parseQuestOverrides(await Bun.file(QUEST_OVERRIDES_PATH).json());
      for (const a of args) {
        const exact = quests.filter((x) => String(x.id) === a || x.code === a);
        const hits = exact.length ? exact : quests.filter((x) => x.name && nameKey(x.name).includes(nameKey(a)));
        if (hits.length === 0) console.log(`${a}: unknown`);
        for (const q of hits) console.log(JSON.stringify({ ...q, override: overrides.find((o) => o.id === q.id) ?? null }, null, 2));
      }
      return;
    }
    case "cells": {
      const [map, ...letters] = args;
      const edges = (await cachedJson("kc3-edges.json", { owner: "KC3Kai", repo: "KC3Kai", ref: "develop", path: "src/data/edges.json" })) as Record<string, Record<string, [string, string]>>;
      const world = edges[`World ${map}`];
      if (!world) {
        console.log(`${map}: no such map in KC3 edges.json`);
        return;
      }
      for (const l of letters) {
        const ids = Object.entries(world).filter(([, [, to]]) => to === l).map(([id]) => Number(id));
        console.log(`${map} ${l}: "cells": ${JSON.stringify(ids)}`);
      }
      return;
    }
    case "missing": {
      const quests = await upstream();
      const done = new Set(parseQuestOverrides(await Bun.file(QUEST_OVERRIDES_PATH).json()).map((o) => o.id));
      const rows = quests.filter((q) => !q.requirements && !done.has(q.id) && (!args[0] || kindOf(q.code) === args[0]));
      for (const q of rows) console.log(`${q.id}\t${q.code ?? "-"}\t${kindOf(q.code)}\t${q.name ?? ""}`);
      console.log(`${rows.length} quests without conditions`);
      return;
    }
    case "check": {
      const m = await master();
      const overrides = parseQuestOverrides(await Bun.file(QUEST_OVERRIDES_PATH).json());
      const ships = new Map(m.ships.map((s) => [s.api_id, s.api_name]));
      const equips = new Map(m.equips.map((e) => [e.api_id, e.api_name]));
      const quests = new Set((await upstream()).map((q) => q.id));
      let bad = 0;
      const walk = (v: unknown, where: string) => {
        if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
        if (!v || typeof v !== "object") return;
        for (const [k, x] of Object.entries(v)) {
          const ids = Array.isArray(x) ? x : [x];
          if (/^(shipIds|flagshipIds|secretaryIds|shipId)$/.test(k)) {
            for (const id of ids) if (!ships.has(id as number)) (bad++, console.log(`${where}.${k}: unknown ship ${id}`));
          } else if (/^(equipIds|equipId)$/.test(k)) {
            for (const id of ids) if (!equips.has(id as number)) (bad++, console.log(`${where}.${k}: unknown equipment ${id}`));
          } else walk(x, `${where}.${k}`);
        }
      };
      for (const o of overrides) {
        if (!quests.has(o.id)) console.log(`${o.id}: not in the upstream quest list (kept as a new quest)`);
        walk(o, String(o.id));
      }
      console.log(`${overrides.length} overrides, ${bad} unknown ids`);
      if (bad) process.exit(1);
      return;
    }
    default:
      console.log(await Bun.file(import.meta.path).text().then((t) => t.split("\n").filter((l) => l.startsWith("//")).join("\n")));
  }
}

if (import.meta.main) {
  await mkdir(dirname(ZEKAMASHI), { recursive: true });
  await main(process.argv[2], process.argv.slice(3));
}
