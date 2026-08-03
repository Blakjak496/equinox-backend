import { JumpBridge, IJumpBridge } from "../models/JumpBridge";
import { System } from "../models/System";
import { ensureRegionIsCached } from "../utils/region-utils";
import { fetchJson } from "../utils/general-utils";

// Extracted from routes/admin.ts so the read-only Tools app can serve the
// exact same known-jump-bridge list and Rift/SMT export without duplicating
// the logic.

// A jump bridge pair may be backed by 1 or 2 persisted JumpBridge docs (one
// per direction, if both sides were separately discovered) - this collapses
// each unordered {home, remote} pair down to one entry, regardless of how
// many directions are actually known, so /known and /map never show the
// same physical bridge twice. systemAId/systemBId may be null if that side
// was never resolved to a system.
export function dedupeJumpBridgePairs(bridges: IJumpBridge[]): {
  systemAName: string;
  systemBName: string;
  systemAId: number | null;
  systemBId: number | null;
}[] {
  const byKey = new Map<string, IJumpBridge[]>();
  for (const bridge of bridges) {
    const key = [bridge.homeSystemName, bridge.remoteSystemName].sort().join("|");
    const bucket = byKey.get(key);
    if (bucket) bucket.push(bridge);
    else byKey.set(key, [bridge]);
  }

  return Array.from(byKey.entries()).map(([key, docs]) => {
    const [systemAName, systemBName] = key.split("|");
    const forward = docs.find((d) => d.homeSystemName === systemAName);
    const backward = docs.find((d) => d.homeSystemName === systemBName);
    return {
      systemAName,
      systemBName,
      systemAId: forward?.homeSystemId ?? backward?.remoteSystemId ?? null,
      systemBId: backward?.homeSystemId ?? forward?.remoteSystemId ?? null,
    };
  });
}

// Two directions per unique pair, always - one backed by a real structureId
// (whichever direction actually has a discovered structure with that
// homeSystemName), the other by null if the reverse structure was never
// discovered. Both Rift and SMT exports below want every pair represented
// bidirectionally regardless of how much of it was actually found.
export function buildJumpBridgeDirections(bridges: IJumpBridge[]): {
  fromName: string;
  toName: string;
  fromSystemId: number | null;
  structureId: number | null;
}[] {
  const byKey = new Map<string, IJumpBridge[]>();
  for (const bridge of bridges) {
    const key = [bridge.homeSystemName, bridge.remoteSystemName].sort().join("|");
    const bucket = byKey.get(key);
    if (bucket) bucket.push(bridge);
    else byKey.set(key, [bridge]);
  }

  const directions: {
    fromName: string;
    toName: string;
    fromSystemId: number | null;
    structureId: number | null;
  }[] = [];

  for (const [key, docs] of byKey) {
    const [nameA, nameB] = key.split("|");
    const forward = docs.find((d) => d.homeSystemName === nameA);
    const backward = docs.find((d) => d.homeSystemName === nameB);
    directions.push({
      fromName: nameA,
      toName: nameB,
      fromSystemId: forward?.homeSystemId ?? backward?.remoteSystemId ?? null,
      structureId: forward?.structureId ?? null,
    });
    directions.push({
      fromName: nameB,
      toName: nameA,
      fromSystemId: backward?.homeSystemId ?? forward?.remoteSystemId ?? null,
      structureId: backward?.structureId ?? null,
    });
  }

  return directions;
}

export async function getKnownJumpBridgePairs(): Promise<
  { systemAName: string; systemBName: string }[]
> {
  const bridges = await JumpBridge.find();
  const pairs = dedupeJumpBridgePairs(bridges).sort((a, b) =>
    a.systemAName.localeCompare(b.systemAName),
  );
  return pairs.map((p) => ({ systemAName: p.systemAName, systemBName: p.systemBName }));
}

// Exports the known jump bridge list as plain text for two third-party
// route-planning tools. Both formats emit every pair bidirectionally (see
// buildJumpBridgeDirections above); SMT additionally needs each direction's
// home region, which isn't something this codebase caches wholesale today
// (Region.ts/ensureRegionIsCached only caches regions actually encountered
// on demand) - so the full region list is fetched live from ESI here.
export async function buildJumpBridgeExportText(
  format: "rift" | "smt",
): Promise<{ text: string; filename: string }> {
  const bridges = await JumpBridge.find();
  const directions = buildJumpBridgeDirections(bridges);

  if (format === "rift") {
    const text = directions.map((d) => `${d.fromName} -> ${d.toName}`).join("\n") + "\n";
    return { text, filename: "jump-bridges-rift.txt" };
  }

  // SMT format only - fetch every region ESI knows about, restricted to
  // the ordinary k-space ID range (10000001-10000070). This is
  // long-documented EVE static data, not a guess made this session, but
  // it's worth reconfirming against a live response if the exported file
  // ever looks like it's missing or including regions unexpectedly -
  // Ansiblex jump bridges only exist in normal space, so wormhole
  // (11000000+) and other non-standard region IDs are excluded.
  const regionsResponse = await fetchJson<number[]>(
    "https://esi.evetech.net/latest/universe/regions/?datasource=tranquility",
    "EquinoxGalactic Admin (jump bridge export)",
  );
  if (!regionsResponse.ok || !regionsResponse.json) {
    throw new Error(
      `ESI region list failed ${regionsResponse.status}: ${regionsResponse.text}`,
    );
  }
  const kSpaceRegionIds = regionsResponse.json.filter(
    (id) => id >= 10000001 && id <= 10000070,
  );
  const allRegions = (
    await Promise.all(kSpaceRegionIds.map((id) => ensureRegionIsCached(id)))
  ).filter((r): r is NonNullable<typeof r> => r !== null);
  allRegions.sort((a, b) => a.name.localeCompare(b.name));

  const fromSystemIds = [
    ...new Set(
      directions.map((d) => d.fromSystemId).filter((id): id is number => id !== null),
    ),
  ];
  const fromSystems = await System.find({ systemId: { $in: fromSystemIds } });
  const regionIdBySystemId = new Map(fromSystems.map((s) => [s.systemId, s.regionId]));

  let text = "";
  for (const region of allRegions) {
    text += `# ${region.name}\n`;
    const regionDirections = directions.filter(
      (d) => d.fromSystemId !== null && regionIdBySystemId.get(d.fromSystemId) === region.regionId,
    );
    for (const d of regionDirections) {
      text += `${d.structureId ?? 0} ${d.fromName} --> ${d.toName}\n`;
    }
    text += "\n";
  }

  return { text, filename: "jump-bridges-smt.txt" };
}
