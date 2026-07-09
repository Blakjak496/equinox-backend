import { ISystem } from "../models/System";
import { IMainRoute } from "../models/MainRoute";
import { ensureSystemIsCached } from "../utils/system-utils";
import { getConfig } from "../lib/config";
import { RouteCostOption, RouteCostResult } from "../types/types";
import { distanceLY } from "../utils/distance-utils";
import { isNullSec } from "../utils/security-utils";
import { findJumpPath, JumpPathResult } from "./jumpPathfinder";

const ISOTOPES_PER_LY = 3000;
const MIN_CONTRACT_BASE = 5_000_000;
const PRICE_PER_M3_PER_LY = 24.85;

function fuelCostPerLY(): number {
  return ISOTOPES_PER_LY * getConfig().isotopePrice;
}

function roundToNearestMillion(value: number): number {
  return Math.round(value / 1_000_000) * 1_000_000;
}

function minimumFromLY(ly: number): number {
  return roundToNearestMillion(ly * fuelCostPerLY()) + MIN_CONTRACT_BASE;
}

function legDistance(leg: JumpPathResult): number | null {
  return "error" in leg ? null : leg.totalDistanceLY;
}

function legPath(leg: JumpPathResult): ISystem[] | null {
  return "error" in leg ? null : leg.path;
}

function reversed(path: ISystem[]): ISystem[] {
  return [...path].reverse();
}

type DetourCandidate = {
  mainRouteName: string;
  extraLY: number;
  path: string[];
};

export async function calculateOptimalRoute(
  pickup: ISystem,
  dropoff: ISystem,
  mainRoutes: IMainRoute[],
  jumpRangeLY: number,
): Promise<RouteCostResult | { error: string }> {
  if (!pickup.position || !dropoff.position) {
    return { error: "Pickup/dropoff system is missing position data" };
  }

  const directLeg = findJumpPath(pickup.systemId, dropoff.systemId, jumpRangeLY);
  if ("error" in directLeg) {
    return { error: directLeg.error };
  }

  const directOneWayLY = directLeg.totalDistanceLY;

  // A dedicated direct trip is a genuine round trip (there's no other
  // reason to make it), so the return leg has to be independently valid -
  // jump travel isn't symmetric wherever high-sec is involved (you can
  // jump out of high-sec but never back in), so it can't just be assumed
  // to cost the same as the outbound leg.
  const returnLeg = findJumpPath(dropoff.systemId, pickup.systemId, jumpRangeLY);
  const directRoundTripLY =
    "error" in returnLeg ? null : directOneWayLY + returnLeg.totalDistanceLY;
  const directMinimum =
    directRoundTripLY !== null ? minimumFromLY(directRoundTripLY) : null;

  // Every active main route gets its own best detour, independently - it's
  // not for this calculator to guess which route is actually applicable
  // right now (whether it's genuinely bidirectional, part of a split round
  // trip, currently being flown at all, etc.). That's a judgment call for
  // the admin, so every route's best option is surfaced rather than
  // silently collapsed into one global "winner."
  const detourCandidates: DetourCandidate[] = [];

  for (const mainRoute of mainRoutes) {
    if (!mainRoute.active) continue;

    const waypointSystems = await Promise.all(
      mainRoute.waypoints.map((systemId) => ensureSystemIsCached(systemId)),
    );

    if (waypointSystems.some((system) => !system?.position)) continue;

    // Distance from every waypoint to pickup/dropoff only needs computing
    // once per waypoint, not once per (i, j) pair - reused below.
    const toPickup = waypointSystems.map((w) =>
      findJumpPath(w!.systemId, pickup.systemId, jumpRangeLY),
    );
    const toDropoff = waypointSystems.map((w) =>
      findJumpPath(w!.systemId, dropoff.systemId, jumpRangeLY),
    );

    let bestForThisRoute: DetourCandidate | null = null;

    // If exactly one of pickup/dropoff already sits on this route, it's
    // reached for free no matter which waypoint anchors the detour - the
    // freighter passes through it as part of its normal, already-scheduled
    // run regardless. The only genuine extra cost is a round-trip spur
    // from whichever established waypoint is closest to the *other*
    // (off-route) point, out and back, with the rest of the route
    // completely untouched. (If neither point is on the route, a spur
    // can never beat a dedicated direct trip by the triangle inequality,
    // so it's not worth searching; if both are on the route, servicing
    // this delivery costs nothing extra, but that's a rare enough case
    // not worth a dedicated candidate here.)
    const pickupOnRoute = mainRoute.waypoints.includes(pickup.systemId);
    const dropoffOnRoute = mainRoute.waypoints.includes(dropoff.systemId);

    if (pickupOnRoute !== dropoffOnRoute) {
      const toOffRoutePoint = pickupOnRoute ? toDropoff : toPickup;

      for (let k = 0; k < waypointSystems.length; k++) {
        const oneWayLY = legDistance(toOffRoutePoint[k]);
        if (oneWayLY === null) continue;

        const extraLY = 2 * oneWayLY;
        if (!bestForThisRoute || extraLY < bestForThisRoute.extraLY) {
          const oneWayPath = legPath(toOffRoutePoint[k])!;
          const path = [...oneWayPath, ...reversed(oneWayPath).slice(1)];

          bestForThisRoute = {
            extraLY,
            mainRouteName: mainRoute.name,
            path: path.map((s) => s.name),
          };
        }
      }
    }

    // j is always i + 1: the main route's own waypoints are stops the
    // freighter is making regardless of this delivery, not optional
    // insertion points to bypass or skip over - even skipping a single one
    // would misprice this delivery against the assumption that waypoint is
    // still being visited, which breaks any other detour anchored there.
    // A detour may only insert between two immediately adjacent waypoints.
    for (let i = 0; i < waypointSystems.length - 1; i++) {
      const j = i + 1;
      const wi = waypointSystems[i]!;
      const wj = waypointSystems[j]!;

      const spineSegmentLY = distanceLY(wi.position!, wj.position!);

      const wiToPickup = legDistance(toPickup[i]);
      const wiToDropoff = legDistance(toDropoff[i]);
      const wjToPickup = legDistance(toPickup[j]);
      const wjToDropoff = legDistance(toDropoff[j]);

      let orderingOneLY = Infinity;
      if (wiToPickup !== null && wjToDropoff !== null) {
        orderingOneLY = wiToPickup + directOneWayLY + wjToDropoff;
      }

      let orderingTwoLY = Infinity;
      if (wiToDropoff !== null && wjToPickup !== null) {
        orderingTwoLY = wiToDropoff + directOneWayLY + wjToPickup;
      }

      const viaDetourLY = Math.min(orderingOneLY, orderingTwoLY);
      if (viaDetourLY === Infinity) continue;

      const extraLY = viaDetourLY - spineSegmentLY;

      if (!bestForThisRoute || extraLY < bestForThisRoute.extraLY) {
        // Ordering one: wi -> pickup -> dropoff -> wj
        // Ordering two: wi -> dropoff -> pickup -> wj
        const path =
          orderingOneLY <= orderingTwoLY
            ? [
                ...legPath(toPickup[i])!,
                ...directLeg.path.slice(1),
                ...reversed(legPath(toDropoff[j])!).slice(1),
              ]
            : [
                ...legPath(toDropoff[i])!,
                ...reversed(directLeg.path).slice(1),
                ...reversed(legPath(toPickup[j])!).slice(1),
              ];

        bestForThisRoute = {
          extraLY,
          mainRouteName: mainRoute.name,
          path: path.map((s) => s.name),
        };
      }
    }

    if (bestForThisRoute) {
      detourCandidates.push(bestForThisRoute);
    }
  }

  // Collateral is suggested whenever either end touches high-sec or
  // low-sec - only a delivery entirely within null-sec (our own established
  // network) is considered safe enough to skip it. Whether a system has a
  // tetherable structure doesn't tell you the pickup/dropoff is actually
  // inside it, so it isn't a factor here.
  const suggestChargeCollateral = !(
    isNullSec(pickup.securityStatus) && isNullSec(dropoff.securityStatus)
  );

  // Priced on the same distance each option's minimum is based on - the
  // marginal extra distance for a detour, the full round trip for a
  // dedicated direct run - not the raw pickup-to-dropoff distance, which
  // would ignore how much further (or less) that option actually flies.
  const options: RouteCostOption[] = detourCandidates.map((candidate) => ({
    mode: "detour",
    pricePerM3: candidate.extraLY * PRICE_PER_M3_PER_LY,
    minimum: minimumFromLY(candidate.extraLY),
    detail: {
      mainRouteName: candidate.mainRouteName,
      extraDistanceLY: candidate.extraLY,
      path: candidate.path,
    },
  }));

  if (directMinimum !== null) {
    options.push({
      mode: "direct",
      pricePerM3: directRoundTripLY! * PRICE_PER_M3_PER_LY,
      minimum: directMinimum,
      detail: {
        directRoundTripLY: directRoundTripLY!,
      },
    });
  }

  if (options.length === 0) {
    return {
      error:
        "No dedicated direct round trip is possible (can't jump back into a high-sec endpoint), and no detour off an active main route is viable.",
    };
  }

  options.sort((a, b) => a.minimum - b.minimum);

  // If direct is the cheapest option (or the only one), none of the main
  // routes are actually cheaper - there's no real choice to make, so just
  // return it on its own rather than presenting a "choice" of one.
  if (options[0].mode === "direct") {
    return { suggestChargeCollateral, options: [options[0]] };
  }

  return { suggestChargeCollateral, options };
}
