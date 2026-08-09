import { fetchJson } from "../utils/general-utils";

// Public endpoint, no auth needed - confirmed live: returns cost_indices
// per system, keyed by activity name, for every system with any industry
// activity at all. ESI only refreshes this once a day, so an in-memory
// cache well under that (1h) avoids hammering it on every resolve without
// ever serving very stale data.
const CACHE_TTL_MS = 60 * 60 * 1000;

type EsiCostIndexEntry = { activity: string; cost_index: number };
type EsiIndustrySystem = {
  solar_system_id: number;
  cost_indices: EsiCostIndexEntry[];
};

// ESI's activity names for the two we care about - "manufacturing" and
// "reaction" match models/Blueprint.ts's activity field exactly, so no
// translation table is needed beyond this type.
export type CostIndexActivity = "manufacturing" | "reaction";

let cache: Map<number, Map<CostIndexActivity, number>> | null = null;
let cachedAt = 0;

async function loadCostIndices(): Promise<Map<number, Map<CostIndexActivity, number>>> {
  const res = await fetchJson<EsiIndustrySystem[]>(
    "https://esi.evetech.net/latest/industry/systems/?datasource=tranquility",
    "EquinoxGalactic Tools (build resolver cost index)",
  );

  if (!res.ok || !res.json) {
    throw new Error(`Failed to fetch ESI industry cost indices: ${res.status}`);
  }

  const bySystem = new Map<number, Map<CostIndexActivity, number>>();
  for (const system of res.json) {
    const byActivity = new Map<CostIndexActivity, number>();
    for (const entry of system.cost_indices) {
      if (entry.activity === "manufacturing" || entry.activity === "reaction") {
        byActivity.set(entry.activity, entry.cost_index);
      }
    }
    bySystem.set(system.solar_system_id, byActivity);
  }
  return bySystem;
}

// Defaults to 0 (no job cost beyond material value) for a system ESI has no
// cost index for - shouldn't happen for any system with real industry
// activity, but a resolve shouldn't hard-fail over it.
export async function getSystemCostIndex(
  systemId: number,
  activity: CostIndexActivity,
): Promise<number> {
  if (!cache || Date.now() - cachedAt > CACHE_TTL_MS) {
    cache = await loadCostIndices();
    cachedAt = Date.now();
  }
  return cache.get(systemId)?.get(activity) ?? 0;
}
