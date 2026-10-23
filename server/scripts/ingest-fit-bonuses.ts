// KC3Kai/kancolle-replay js/data/mst_slotitem_bonus.json -> fit_bonuses (structure kept verbatim; interpreted by
// shared/sim/fit.ts like kancolle-replay's getBonusStats). ElectronicObserverEN/Data FitBonuses.json, used before,
// stopped being updated in 2025-03 (docs/DATA_SOURCES.md §2, docs/VALIDATION.md §4).
import { execStatements } from "./lib/d1";
import { fetchGithub } from "./lib/fetch";
import { sourceRef, sourceUpsert, upsert } from "./lib/sql";

const FILE = { owner: "KC3Kai", repo: "kancolle-replay", ref: "master", path: "js/data/mst_slotitem_bonus.json" };
const FIT_SOURCE_KEY = "kcr-slotitem-bonus";

interface FitBonusEntry { ids?: number[]; types?: number[]; bonuses: unknown[] }

export async function ingestFitBonuses(): Promise<void> {
  const { text, url, revision } = await fetchGithub(FILE);
  // The file is a JSON array of entries in kancolle-replay's format.
  const entries = JSON.parse(text) as FitBonusEntry[];
  const src = sourceRef(FIT_SOURCE_KEY);
  const rows = entries.map((e, i) => ({
    id: i, equip_ids: e.ids ?? null, equip_types: e.types ?? null, bonuses: e.bonuses, source_id: src,
  }));
  await execStatements("fit-bonuses", [
    sourceUpsert({ key: FIT_SOURCE_KEY, name: "KC3Kai/kancolle-replay mst_slotitem_bonus.json", url, licence: "MIT", revision }),
    "DELETE FROM fit_bonuses;",
    ...upsert("fit_bonuses", rows, ["id"]),
  ]);
  console.log(`fit bonuses @${revision.slice(0, 12)}: ${rows.length} entries`);
}

if (import.meta.main) await ingestFitBonuses();
