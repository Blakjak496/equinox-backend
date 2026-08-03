import { ShipCategory } from "../models/ShipCategory";
import { Structure } from "../models/Structure";
import { getSystemIdByName, ensureSystemIsCached } from "../utils/system-utils";
import { findJumpPath } from "./jumpPathfinder";
import { KEEPSTAR_TYPE_ID } from "./keepstarDiscovery";
import { computeMapBoundsAndRegions, MapView } from "./mapView";
import { effectiveJumpRangeLY, isValidSkillLevel } from "../utils/jumpRange";

// Extracted from routes/admin.ts's POST /jump-routes/plan handler so the
// read-only Tools app can reuse the exact same routing logic (including the
// "restrict to known Keepstars" behavior) without duplicating it.

export type PlanJumpRouteResult =
  | {
      ok: true;
      data: {
        stops: { systemName: string; keepstarName: string | null }[];
        totalDistanceLY: number;
      } & MapView;
    }
  | { ok: false; status: number; message: string };

export async function planJumpRoute(
  waypointNames: string[],
  shipCategoryId: string,
  restrictToKeepstars: boolean,
  skillLevel: number,
): Promise<PlanJumpRouteResult> {
  if (!Array.isArray(waypointNames) || waypointNames.length < 2 || !shipCategoryId) {
    return {
      ok: false,
      status: 400,
      message: "waypointNames (at least 2) and shipCategoryId are required",
    };
  }

  if (!isValidSkillLevel(skillLevel)) {
    return {
      ok: false,
      status: 400,
      message: "skillLevel must be an integer from 1 to 5 (your trained Jump Drive Calibration level)",
    };
  }

  const shipCategory = await ShipCategory.findById(shipCategoryId);
  if (!shipCategory) {
    return { ok: false, status: 404, message: "Ship category not found" };
  }

  const jumpRangeLY = effectiveJumpRangeLY(shipCategory.baseRangeLY, skillLevel);

  const systemIds = await Promise.all(
    waypointNames.map((name) => getSystemIdByName(name)),
  );

  const missingIndex = systemIds.findIndex((id) => !id);
  if (missingIndex !== -1) {
    return {
      ok: false,
      status: 404,
      message: `Could not resolve "${waypointNames[missingIndex]}"`,
    };
  }

  const systems = await Promise.all(systemIds.map((id) => ensureSystemIsCached(id!)));

  // Computed unconditionally, not just when restricted, so a system that
  // happens to host a known Keepstar still gets its label/stop annotation
  // even on an unrestricted route.
  const knownKeepstars = await Structure.find({ typeId: KEEPSTAR_TYPE_ID, access: "ok" });
  const keepstarSystemIds = new Set<number>();
  const keepstarNameBySystemId = new Map<number, string>();
  for (const keepstar of knownKeepstars) {
    if (keepstar.systemId === null) continue;
    keepstarSystemIds.add(keepstar.systemId);
    if (!keepstarNameBySystemId.has(keepstar.systemId)) {
      keepstarNameBySystemId.set(keepstar.systemId, keepstar.name ?? "Unknown");
    }
  }

  if (restrictToKeepstars) {
    const badIndex = systems.findIndex((s) => !s || !keepstarSystemIds.has(s.systemId));
    if (badIndex !== -1) {
      return {
        ok: false,
        status: 400,
        message: `"${waypointNames[badIndex]}" is not a known Keepstar system`,
      };
    }
  }

  const fullPath: { systemId: number; name: string }[] = [
    { systemId: systems[0]!.systemId, name: systems[0]!.name },
  ];
  let totalDistanceLY = 0;

  for (let i = 0; i < systems.length - 1; i++) {
    const leg = findJumpPath(
      systems[i]!.systemId,
      systems[i + 1]!.systemId,
      jumpRangeLY,
      restrictToKeepstars ? keepstarSystemIds : undefined,
    );

    if ("error" in leg) {
      return { ok: false, status: 400, message: leg.error };
    }

    totalDistanceLY += leg.totalDistanceLY;
    for (const system of leg.path.slice(1)) {
      fullPath.push({ systemId: system.systemId, name: system.name });
    }
  }

  const stops = fullPath.map((entry) => ({
    systemName: entry.name,
    keepstarName: keepstarNameBySystemId.get(entry.systemId) ?? null,
  }));

  const mapView = await computeMapBoundsAndRegions(fullPath, keepstarNameBySystemId);

  return {
    ok: true,
    data: { stops, totalDistanceLY, ...mapView },
  };
}
