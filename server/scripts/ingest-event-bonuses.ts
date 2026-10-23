// kancolle-replay js/data/bonus/*.json (MIT) + server/data/event-bonuses.json (manual, current events) -> event_bonuses.
import { execStatements } from "./lib/d1";
import { fetchText, rawUrl } from "./lib/fetch";
import { sourceRef, sourceUpsert, upsert } from "./lib/sql";
import { eventBonusDoc, flattenEventBonus, mergeEventBonuses } from "../src/eventBonus";

const REPO = { owner: "KC3Kai", repo: "kancolle-replay", ref: "master" };
const KEY = "kancolle-replay-event-bonus";
const MANUAL_KEY = "manual-event-bonus";
const MANUAL_FILE = new URL("../data/event-bonuses.json", import.meta.url);

export async function ingestEventBonuses(): Promise<void> {
  const headers: Record<string, string> = { "User-Agent": "kc-sim-ingest", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/git/trees/${REPO.ref}?recursive=1`, { headers });
  if (!res.ok) throw new Error(`tree listing -> ${res.status}`);
  const tree = (await res.json()) as { sha: string; tree: { path: string }[] };
  const paths = tree.tree.map((t) => t.path).filter((p) => /^js\/data\/bonus\/\d+-\d+\.json$/.test(p));
  const replay = [];
  for (const path of paths) {
    const doc = eventBonusDoc.safeParse(JSON.parse(await fetchText(rawUrl({ ...REPO, path }))));
    if (!doc.success) throw new Error(`${path}: ${doc.error.message}`);
    replay.push(flattenEventBonus(doc.data));
  }

  const manualText = await Bun.file(MANUAL_FILE).text();
  const manualDocs = eventBonusDoc.array().safeParse(JSON.parse(manualText));
  if (!manualDocs.success) throw new Error(`server/data/event-bonuses.json: ${manualDocs.error.message}`);
  const manual = manualDocs.data.map(flattenEventBonus);

  const rows = mergeEventBonuses(replay, manual).map((f) => ({
    map_id: f.mapId, date: f.date, note: f.note, bonuses: f.bonuses, lbas_bonuses: f.lbasBonuses, debuffs: f.debuffs,
    source_id: sourceRef(f.manual ? MANUAL_KEY : KEY),
  }));
  await execStatements("event-bonuses", [
    sourceUpsert({
      key: KEY, name: "kancolle-replay js/data/bonus", url: `https://github.com/${REPO.owner}/${REPO.repo}/tree/${REPO.ref}/js/data/bonus`,
      licence: "MIT", revision: tree.sha,
    }),
    sourceUpsert({
      key: MANUAL_KEY, name: "kc-sim server/data/event-bonuses.json", url: "server/data/event-bonuses.json", licence: "repository",
      revision: `sha256:${new Bun.CryptoHasher("sha256").update(manualText).digest("hex")}`,
    }),
    "DELETE FROM event_bonuses;",
    ...upsert("event_bonuses", rows, ["map_id"]),
  ]);
  console.log(`event bonuses @${tree.sha.slice(0, 12)}: ${replay.length} replay maps, ${manual.length} manual, ${rows.length} rows`);
}

if (import.meta.main) await ingestEventBonuses();
