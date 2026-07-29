import { System } from "../models/System";
import { ensureRegionIsCached } from "../utils/region-utils";
import { METERS_PER_LY } from "../utils/distance-utils";

export type MapBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type MapSystem = {
  systemId: number;
  name: string;
  x: number;
  z: number;
  securityStatus: number | null;
  regionId: number | null;
  // "Is this system one of the points of interest for this particular map
  // view" - a route stop for the jump planner, or a jump-bridge endpoint for
  // the jump-bridge map. Field name kept as isOnRoute (not generalized) since
  // it's an established API shape multiple frontend call sites already read.
  isOnRoute: boolean;
  keepstarName: string | null;
};

export type MapPoint = {
  x: number;
  z: number;
};

export type MapRegion = {
  regionId: number;
  name: string;
  x: number;
  z: number;
};

export type MapView = {
  bounds: MapBounds;
  systemsInView: MapSystem[];
  routePath: MapPoint[];
  regions: MapRegion[];
};

// Shared by the jump planner (focalSystems = ordered route stops, routePath
// used to draw the connected arc) and the jump-bridge map (focalSystems =
// every bridge endpoint, in no particular order - routePath is simply
// unused by that caller). Extracted from the old POST /keepstar-routes/plan
// handler, which did this same bounding-box + region-centroid computation
// inline.
export async function computeMapBoundsAndRegions(
  focalSystems: { systemId: number; name: string }[],
  keepstarNameBySystemId: Map<number, string>,
): Promise<MapView> {
  const onRouteSystemIds = new Set(focalSystems.map((entry) => entry.systemId));
  const routeSystems = await System.find({
    systemId: { $in: Array.from(onRouteSystemIds) },
  });

  // Mongo's $in doesn't preserve array order, so route-order coordinates
  // (needed to draw the path as a connected line rather than a scatter) are
  // rebuilt below by mapping focalSystems - which IS in the caller's true
  // order - through this lookup, rather than relying on routeSystems' order.
  const positionBySystemId = new Map(
    routeSystems.filter((s) => s.position).map((s) => [s.systemId, s.position!]),
  );

  const xsLY = routeSystems
    .filter((s) => s.position)
    .map((s) => s.position!.x / METERS_PER_LY);
  const zsLY = routeSystems
    .filter((s) => s.position)
    .map((s) => s.position!.z / METERS_PER_LY);

  // 2D projection uses the x/z plane (dropping y) - the conventional
  // projection for EVE's starmap, since the galaxy's disc-shaped spread is
  // dominant on those two axes.
  const rawMinX = Math.min(...xsLY);
  const rawMaxX = Math.max(...xsLY);
  const rawMinZ = Math.min(...zsLY);
  const rawMaxZ = Math.max(...zsLY);

  // A genuine square, not just an independently-padded rectangle: take the
  // longer of the two axis spans, pad it, then center that single side
  // length on the bounding-box center. Padding also keeps a very short (or
  // degenerate single-point) set of focal systems from collapsing to a
  // zero-size box.
  const centerX = (rawMinX + rawMaxX) / 2;
  const centerZ = (rawMinZ + rawMaxZ) / 2;
  const spanLY = Math.max(rawMaxX - rawMinX, rawMaxZ - rawMinZ, 1);
  const halfSideLY = spanLY / 2 + Math.max(spanLY * 0.3, 5);

  const bounds: MapBounds = {
    minX: centerX - halfSideLY,
    maxX: centerX + halfSideLY,
    minZ: centerZ - halfSideLY,
    maxZ: centerZ + halfSideLY,
  };

  const systemsInView = await System.find({
    "position.x": {
      $gte: bounds.minX * METERS_PER_LY,
      $lte: bounds.maxX * METERS_PER_LY,
    },
    "position.z": {
      $gte: bounds.minZ * METERS_PER_LY,
      $lte: bounds.maxZ * METERS_PER_LY,
    },
  });

  const systemsInViewData: MapSystem[] = systemsInView
    .filter((s) => s.position)
    .map((s) => ({
      systemId: s.systemId,
      name: s.name,
      x: s.position!.x / METERS_PER_LY,
      z: s.position!.z / METERS_PER_LY,
      securityStatus: s.securityStatus,
      regionId: s.regionId,
      isOnRoute: onRouteSystemIds.has(s.systemId),
      keepstarName: keepstarNameBySystemId.get(s.systemId) ?? null,
    }));

  // One label per region actually present in view, positioned at the
  // centroid of that region's in-view systems (not the region's true
  // full-universe centroid - we only ever have position data for the padded
  // box already being shown, and that's the only area this map needs a
  // label to be meaningful within).
  const systemIdsByRegionId = new Map<number, { x: number; z: number }[]>();
  for (const system of systemsInViewData) {
    if (system.regionId === null) continue;
    const bucket = systemIdsByRegionId.get(system.regionId);
    if (bucket) bucket.push({ x: system.x, z: system.z });
    else systemIdsByRegionId.set(system.regionId, [{ x: system.x, z: system.z }]);
  }

  const regionEntries: MapRegion[] = await Promise.all(
    Array.from(systemIdsByRegionId.entries()).map(async ([regionId, points]) => {
      const region = await ensureRegionIsCached(regionId);
      const centroidX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
      const centroidZ = points.reduce((sum, p) => sum + p.z, 0) / points.length;
      return {
        regionId,
        name: region?.name ?? `Region ${regionId}`,
        x: centroidX,
        z: centroidZ,
      };
    }),
  );

  const routePath: MapPoint[] = focalSystems
    .map((entry) => {
      const position = positionBySystemId.get(entry.systemId);
      if (!position) return null;
      return { x: position.x / METERS_PER_LY, z: position.z / METERS_PER_LY };
    })
    .filter((p): p is MapPoint => p !== null);

  return { bounds, systemsInView: systemsInViewData, routePath, regions: regionEntries };
}
