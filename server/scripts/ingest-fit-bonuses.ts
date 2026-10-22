// ElectronicObserverEN/Data Data/FitBonuses.json -> fit_bonuses (structure kept verbatim; same format as
// kancolle-replay js/data/mst_slotitem_bonus.json).
import { execStatements } from "./lib/d1";
import { fetchGithub } from "./lib/fetch";
import { sourceRef, sourceUpsert, upsert } from "./lib/sql";

const FILE = { owner: "ElectronicObserverEN", repo: "Data", ref: "master", path: "Data/FitBonuses.json" };
const KEY = "eo-fit-bonuses";

interface FitBonusEntry { ids?: number[]; types?: number[]; bonuses: unknown[] }

export async function ingestFitBonuses(): Promise<void> {
  const { text, url, revision } = await fetchGithub(FILE);
  const entries = JSON.parse(text) as FitBonusEntry[];
  const src = sourceRef(KEY);
  const rows = entries.map((e, i) => ({
    id: i, equip_ids: e.ids ?? null, equip_types: e.types ?? null, bonuses: e.bonuses, source_id: src,
  }));
  await execStatements("fit-bonuses", [
    sourceUpsert({ key: KEY, name: "ElectronicObserverEN/Data FitBonuses.json", url, licence: "none stated", revision }),
    "DELETE FROM fit_bonuses;",
    ...upsert("fit_bonuses", rows, ["id"]),
  ]);
  console.log(`fit bonuses @${revision.slice(0, 12)}: ${rows.length} entries`);
}

if (import.meta.main) await ingestFitBonuses();
