// Emits seed/routing/routing.schema.json from the zod schema (single source of truth).
import * as z from "zod";
import { routingDoc } from "../src/routing/schema";

const schema = z.toJSONSchema(routingDoc, { target: "draft-2020-12" });
const out = new URL("../seed/routing/routing.schema.json", import.meta.url);
await Bun.write(out, JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${out.pathname}`);
