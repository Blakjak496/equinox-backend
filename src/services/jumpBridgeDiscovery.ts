import { EsiAuth } from "../models/EsiAuth";
import { getAccessToken } from "../lib/esiClient";
import { getOrFetchStructure } from "../utils/structure-utils";
import { ensureSystemIsCached, getSystemIdByName } from "../utils/system-utils";
import { fetchJsonWithBearer } from "../utils/general-utils";
import { JumpBridge } from "../models/JumpBridge";

// Ansiblex jump bridges have no confirmed-live type ID in this codebase
// (unlike KEEPSTAR_TYPE_ID in keepstarDiscovery.ts) - classification here is
// name-pattern based instead, per the user's own confirmed search behavior:
// every Ansiblex they've checked follows "{SystemA} » {SystemB} - {Name}",
// and the ESI structure search below already finds them all with a single
// substring query (" » ").
const JUMP_BRIDGE_NAME_PATTERN = /^(.+?)\s*»\s*(.+?)\s+-\s+.+$/;

export type JumpBridgeDiscoveryOutcome =
  | "jump_bridge"
  // Matched the name pattern, but neither captured system name matches this
  // structure's own ESI-reported system - reported instead of silently
  // dropped so the admin can see it happened.
  | "jump_bridge_ambiguous"
  | "other_structure"
  | "no_access"
  | "error";

export type JumpBridgeDiscoveryResult = {
  structureId: number;
  outcome: JumpBridgeDiscoveryOutcome;
  name: string | null;
  systemName: string | null;
  detail: string | null;
};

export type JumpBridgeDiscoveryResponse = {
  searchQuery: string;
  totalFound: number;
  results: JumpBridgeDiscoveryResult[];
};

// Same pacing as keepstarDiscovery.ts's RESOLVE_DELAY_MS - kept as a
// separate constant rather than a shared import since these two discovery
// services are deliberately independent (see this file's own doc comment).
const RESOLVE_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same shape-parsing trick as keepstarDiscovery.ts - getOrFetchStructure's
// low-budget guard throws a message containing "reset=<seconds>" rather than
// exposing it as structured data.
function parseBudgetResetSeconds(message: string): number | null {
  const match = message.match(/reset=(\d+)/);
  return match ? Number(match[1]) : null;
}

// Deliberately duplicated rather than shared with keepstarDiscovery.ts -
// each discovery service is a small, self-contained pipeline over the same
// ESI character-structure-search primitive, matching this codebase's
// existing precedent for this kind of feature.
export async function discoverJumpBridges(
  searchQuery: string,
): Promise<JumpBridgeDiscoveryResponse> {
  if (searchQuery.trim() === "") {
    throw new Error(
      "A non-empty search query is required - ESI rejects a blank query outright.",
    );
  }

  const accessToken = await getAccessToken();
  const auth = await EsiAuth.findOne();
  if (!auth) throw new Error("No ESI auth found. Eve account not connected.");

  const characterId = auth.characterId;
  const url = `https://esi.evetech.net/latest/characters/${characterId}/search/?categories=structure&search=${encodeURIComponent(searchQuery)}&datasource=tranquility`;

  console.log(
    `[jumpBridgeDiscovery] searching structures for character ${characterId}, query="${searchQuery}"`,
  );

  const searchResponse = await fetchJsonWithBearer<{
    structure?: number[];
  }>(url, accessToken, "EquinoxGalactic Admin (jump bridge discovery)");

  console.log(
    `[jumpBridgeDiscovery] search response status=${searchResponse.status} body=${searchResponse.text}`,
  );

  if (!searchResponse.ok || !searchResponse.json) {
    throw new Error(
      `ESI character search failed ${searchResponse.status}: ${searchResponse.text}`,
    );
  }

  const structureIds = searchResponse.json.structure ?? [];
  console.log(
    `[jumpBridgeDiscovery] ${structureIds.length} candidate structure id(s) returned`,
  );

  const results: JumpBridgeDiscoveryResult[] = [];

  for (let i = 0; i < structureIds.length; i++) {
    const structureId = structureIds[i];
    try {
      const structure = await getOrFetchStructure(structureId, accessToken);

      if (!structure || !("access" in structure)) {
        results.push({
          structureId,
          outcome: "other_structure",
          name: null,
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
          systemName: null,
          detail: null,
        });
        continue;
      }

      const match = structure.name?.match(JUMP_BRIDGE_NAME_PATTERN) ?? null;
      if (!match) {
        results.push({
          structureId,
          outcome: "other_structure",
          name: structure.name,
          systemName: structure.systemName,
          detail: null,
        });
        continue;
      }

      const [, capturedA, capturedB] = match;
      const homeSystemName = structure.systemName;
      let remoteSystemName: string | null = null;
      if (homeSystemName?.toLowerCase() === capturedA.trim().toLowerCase()) {
        remoteSystemName = capturedB.trim();
      } else if (homeSystemName?.toLowerCase() === capturedB.trim().toLowerCase()) {
        remoteSystemName = capturedA.trim();
      }

      if (!homeSystemName || !structure.systemId || !remoteSystemName) {
        results.push({
          structureId,
          outcome: "jump_bridge_ambiguous",
          name: structure.name,
          systemName: structure.systemName,
          detail: `Neither "${capturedA.trim()}" nor "${capturedB.trim()}" matched this structure's own system "${homeSystemName ?? "unknown"}"`,
        });
        continue;
      }

      const remoteSystemId = await getSystemIdByName(remoteSystemName);
      // getOrFetchStructure above already ensured the home system is cached
      // (position/regionId, needed for map rendering and region export) -
      // getSystemIdByName only resolves the ID, so the remote side needs
      // the same treatment done explicitly here.
      if (remoteSystemId) await ensureSystemIsCached(remoteSystemId);

      await JumpBridge.findOneAndUpdate(
        { structureId },
        {
          structureId,
          name: structure.name,
          homeSystemName,
          homeSystemId: structure.systemId,
          remoteSystemName,
          remoteSystemId,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      results.push({
        structureId,
        outcome: "jump_bridge",
        name: structure.name,
        systemName: structure.systemName,
        detail: remoteSystemId
          ? null
          : `Could not resolve remote system "${remoteSystemName}" - persisted with a null remoteSystemId`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[jumpBridgeDiscovery] failed to resolve structure ${structureId}:`,
        err,
      );
      results.push({
        structureId,
        outcome: "error",
        name: null,
        systemName: null,
        detail: message,
      });

      const resetSeconds = parseBudgetResetSeconds(message);
      if (resetSeconds !== null) {
        console.warn(
          `[jumpBridgeDiscovery] ESI error budget exhausted, pausing ${resetSeconds}s before resuming (${structureIds.length - i - 1} candidate(s) left)`,
        );
        await sleep(resetSeconds * 1000);
      }
    }

    if (i < structureIds.length - 1) {
      await sleep(RESOLVE_DELAY_MS);
    }
  }

  const jumpBridgeCount = results.filter((r) => r.outcome === "jump_bridge").length;
  console.log(
    `[jumpBridgeDiscovery] resolved ${results.length}/${structureIds.length} candidates - ${jumpBridgeCount} jump bridge(s) found`,
  );

  return { searchQuery, totalFound: structureIds.length, results };
}
