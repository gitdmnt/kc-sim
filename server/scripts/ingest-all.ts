// Runs every ingest job in dependency order against the local D1, then prints row counts.
import { query } from "./lib/d1";
import { ingestStart2 } from "./ingest-start2";
import { ingestAbyssal } from "./ingest-abyssal";
import { ingestMapGraph } from "./ingest-map-graph";
import { ingestFitBonuses } from "./ingest-fit-bonuses";
import { ingestRouting } from "./ingest-routing";

await ingestStart2();
await ingestAbyssal();
await ingestMapGraph();
await ingestFitBonuses();
await ingestRouting();

const tables = ["sources", "ship_types", "ships", "equip_types", "equipments", "maps", "nodes", "edges", "routing_maps",
  "routing_rules", "estimates", "fit_bonuses", "enemy_comp_sets", "enemy_comps", "enemy_comp_ships", "observations",
  "kcnav_queue", "kcnav_cache"];
const rows = await query<Record<string, number>>(`SELECT ${tables.map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(", ")}`);
console.table(rows[0]);
