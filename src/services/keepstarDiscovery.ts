import { EsiAuth } from "../models/EsiAuth";
import { getAccessToken } from "../lib/esiClient";
import { getOrFetchStructure } from "../utils/structure-utils";
import { fetchJsonWithBearer } from "../utils/general-utils";

// Keepstar's inventory type ID - confirmed live against ESI
// (POST /universe/ids/ with name "Keepstar"), not assumed. 35832 is the
// Astrahus, a different Upwell citadel size class - do not confuse the two.
export const KEEPSTAR_TYPE_ID = 35834;

export type KeepstarDiscoveryOutcome =
  | "keepstar"
  | "other_structure"
  | "no_access"
  | "error";

export type KeepstarDiscoveryResult = {
  structureId: number;
  outcome: KeepstarDiscoveryOutcome;
  name: string | null;
  typeName: string | null;
  systemName: string | null;
  detail: string | null;
};

export type KeepstarDiscoveryResponse = {
  searchQuery: string;
  totalFound: number;
  results: KeepstarDiscoveryResult[];
};

// Baseline pacing between resolve calls - keeps a large, mostly-uncached
// candidate batch (up to 500 IDs, ESI's search maxItems) from bursting.
const RESOLVE_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// getOrFetchStructure's low-budget guard (general-utils.ts's
// checkEsiLimitFromHeader) throws a message of this exact shape rather than
// exposing the reset window as structured data - parsed back out here so a
// budget-exhaustion signal actually pauses the batch (matching
// corpAssetSync.ts's sleep-then-continue circuit breaker) instead of just
// being recorded as one failed item while every remaining candidate in the
// batch immediately repeats the same failure at full speed.
function parseBudgetResetSeconds(message: string): number | null {
  const match = message.match(/reset=(\d+)/);
  return match ? Number(match[1]) : null;
}

// ESI has no endpoint that lists "every structure a character can dock at" -
// the closest available mechanism is this character-scoped search, which
// (per ESI community precedent, unverified in this environment since it
// requires a live authenticated token) only returns structures that
// character has already discovered - i.e. exactly what shows in their
// in-game Structure Browser. Every step here logs its raw result under a
// [keepstarDiscovery] prefix and returns full per-item detail rather than a
// collapsed summary, since this is the only way to debug the pipeline
// without direct server log access.
export async function discoverKeepstars(
  searchQuery: string,
): Promise<KeepstarDiscoveryResponse> {
  const accessToken = await getAccessToken();
  const auth = await EsiAuth.findOne();
  if (!auth) throw new Error("No ESI auth found. Eve account not connected.");

  const characterId = auth.characterId;
  const url = `https://esi.evetech.net/latest/characters/${characterId}/search/?categories=structure&search=${encodeURIComponent(searchQuery)}&datasource=tranquility`;

  console.log(
    `[keepstarDiscovery] searching structures for character ${characterId}, query="${searchQuery}"`,
  );

  const searchResponse = await fetchJsonWithBearer<{
    structure?: number[];
  }>(url, accessToken, "EquinoxGalactic Admin (keepstar discovery)");

  console.log(
    `[keepstarDiscovery] search response status=${searchResponse.status} body=${searchResponse.text}`,
  );

  if (!searchResponse.ok || !searchResponse.json) {
    throw new Error(
      `ESI character search failed ${searchResponse.status}: ${searchResponse.text}`,
    );
  }

  const structureIds = searchResponse.json.structure ?? [];
  console.log(
    `[keepstarDiscovery] ${structureIds.length} candidate structure id(s) returned`,
  );

  const results: KeepstarDiscoveryResult[] = [];

  for (let i = 0; i < structureIds.length; i++) {
    const structureId = structureIds[i];
    try {
      const structure = await getOrFetchStructure(structureId, accessToken);

      if (!structure || !("access" in structure)) {
        // Station-range ID showed up in a structure-category search, which
        // shouldn't happen in practice, but the resolver is shared with
        // stations so this is handled rather than assumed impossible.
        results.push({
          structureId,
          outcome: "other_structure",
          name: null,
          typeName: null,
          systemName: null,
          detail: "resolved as a station, not a structure",
        });
        continue;
      }

      if (structure.access === "forbidden") {
        results.push({
          structureId,
          outcome: "no_access",
          name: null,
          typeName: null,
          systemName: null,
          detail: null,
        });
        continue;
      }

      const outcome: KeepstarDiscoveryOutcome =
        structure.typeId === KEEPSTAR_TYPE_ID ? "keepstar" : "other_structure";

      results.push({
        structureId,
        outcome,
        name: structure.name,
        typeName: structure.typeName,
        systemName: structure.systemName,
        detail: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[keepstarDiscovery] failed to resolve structure ${structureId}:`,
        err,
      );
      results.push({
        structureId,
        outcome: "error",
        name: null,
        typeName: null,
        systemName: null,
        detail: message,
      });

      const resetSeconds = parseBudgetResetSeconds(message);
      if (resetSeconds !== null) {
        console.warn(
          `[keepstarDiscovery] ESI error budget exhausted, pausing ${resetSeconds}s before resuming (${structureIds.length - i - 1} candidate(s) left)`,
        );
        await sleep(resetSeconds * 1000);
      }
    }

    if (i < structureIds.length - 1) {
      await sleep(RESOLVE_DELAY_MS);
    }
  }

  const keepstarCount = results.filter((r) => r.outcome === "keepstar").length;
  console.log(
    `[keepstarDiscovery] resolved ${results.length}/${structureIds.length} candidates - ${keepstarCount} keepstar(s) found`,
  );

  return { searchQuery, totalFound: structureIds.length, results };
}
