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

// Sum of the route's own spine segments between two of its waypoint
// indices - the distance the freighter already covers riding the
// established route between those two stops, regardless of which index is
// numerically larger.
function rideAlongLY(
  waypoints: ISystem[],
  indexA: number,
  indexB: number,
): number {
  const lo = Math.min(indexA, indexB);
  const hi = Math.max(indexA, indexB);
  let total = 0;
  for (let k = lo; k < hi; k++) {
    total += distanceLY(waypoints[k].position!, waypoints[k + 1].position!);
  }
  return total;
}

// The route's own waypoints, in order, starting at fromIndex and ending at
// toIndex - reversed from the stored array order if fromIndex is the later
// stop, since the route may be flown either direction.
function orderedRideSegment(
  waypoints: ISystem[],
  fromIndex: number,
  toIndex: number,
): ISystem[] {
  const lo = Math.min(fromIndex, toIndex);
  const hi = Math.max(fromIndex, toIndex);
  const segment = waypoints.slice(lo, hi + 1);
  return fromIndex <= toIndex ? segment : reversed(segment);
}

type DetourCandidate = {
  mainRouteName: string;
  distanceLY: number;
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
  //
  // Every candidate is billed on the actual one-way distance the cargo
  // travels from pickup to dropoff via that route - not a round trip (the
  // freighter isn't making a dedicated trip; it's already going that way
  // for other reasons) and not some "extra distance only" discount either.
  // A detour is worth less than a dedicated direct trip because it skips
  // the return leg, not because the customer is only paying for a sliver
  // of the journey.
  const detourCandidates: DetourCandidate[] = [];

  for (const mainRoute of mainRoutes) {
    if (!mainRoute.active) continue;

    const waypointSystems = await Promise.all(
      mainRoute.waypoints.map((systemId) => ensureSystemIsCached(systemId)),
    );

    if (waypointSystems.some((system) => !system?.position)) continue;
    const waypoints = waypointSystems as ISystem[];

    // Distance from every waypoint to pickup/dropoff only needs computing
    // once per waypoint, not once per (i, j) pair - reused below.
    const toPickup = waypoints.map((w) =>
      findJumpPath(w.systemId, pickup.systemId, jumpRangeLY),
    );
    const toDropoff = waypoints.map((w) =>
      findJumpPath(w.systemId, dropoff.systemId, jumpRangeLY),
    );

    let bestForThisRoute: DetourCandidate | null = null;

    const pickupIndex = mainRoute.waypoints.indexOf(pickup.systemId);
    const dropoffIndex = mainRoute.waypoints.indexOf(dropoff.systemId);
    const pickupOnRoute = pickupIndex !== -1;
    const dropoffOnRoute = dropoffIndex !== -1;

    if (pickupOnRoute && dropoffOnRoute) {
      // Both stops are already scheduled waypoints on this route - the
      // freighter flies between them regardless of this delivery. Billed
      // distance is the route's own sub-segment between the two waypoints,
      // in whichever order they appear (this route may be flown either
      // direction).
      const path = orderedRideSegment(waypoints, pickupIndex, dropoffIndex);

      bestForThisRoute = {
        distanceLY: rideAlongLY(waypoints, pickupIndex, dropoffIndex),
        mainRouteName: mainRoute.name,
        path: path.map((s) => s.name),
      };
    } else if (pickupOnRoute !== dropoffOnRoute) {
      // Exactly one point is already a scheduled waypoint - the freighter
      // rides the route (already flying that regardless) from that
      // waypoint to whichever anchor is cheapest to jump off from, then
      // makes a one-way hop to the off-route point. Billed distance is
      // that ride-along leg plus the one-way jump, not a round trip -
      // the cargo only ever travels one way, from pickup to dropoff.
      const onRouteIndex = pickupOnRoute ? pickupIndex : dropoffIndex;
      const toOffRoutePoint = pickupOnRoute ? toDropoff : toPickup;

      for (let k = 0; k < waypoints.length; k++) {
        const spurLY = legDistance(toOffRoutePoint[k]);
        if (spurLY === null) continue;

        const distance = rideAlongLY(waypoints, onRouteIndex, k) + spurLY;

        if (!bestForThisRoute || distance < bestForThisRoute.distanceLY) {
          const spurPath = legPath(toOffRoutePoint[k])!;

          const path = pickupOnRoute
            ? [...orderedRideSegment(waypoints, pickupIndex, k), ...spurPath.slice(1)]
            : [
                ...reversed(spurPath),
                ...orderedRideSegment(waypoints, k, dropoffIndex).slice(1),
              ];

          bestForThisRoute = {
            distanceLY: distance,
            mainRouteName: mainRoute.name,
            path: path.map((s) => s.name),
          };
        }
      }
    } else {
      // Neither point is on the route - the cargo's actual journey is just
      // the direct pickup -> dropoff hop, so that's the billed distance
      // regardless of where it's inserted. The search below only
      // determines whether this route can feasibly host the delivery at
      // all (some gap close enough to reach both ends - j is always i + 1,
      // the route's own waypoints aren't optional stops to skip over) and
      // which gap gives the most sensible path to display.
      let bestInsertion: { overheadLY: number; path: ISystem[] } | null = null;

      for (let i = 0; i < waypoints.length - 1; i++) {
        const j = i + 1;
        const wi = waypoints[i];
        const wj = waypoints[j];

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

        const overheadLY = viaDetourLY - spineSegmentLY;

        if (!bestInsertion || overheadLY < bestInsertion.overheadLY) {
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

          bestInsertion = { overheadLY, path };
        }
      }

      if (bestInsertion) {
        bestForThisRoute = {
          distanceLY: directOneWayLY,
          mainRouteName: mainRoute.name,
          path: bestInsertion.path.map((s) => s.name),
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

  const options: RouteCostOption[] = detourCandidates.map((candidate) => ({
    mode: "detour",
    pricePerM3: candidate.distanceLY * PRICE_PER_M3_PER_LY,
    minimum: minimumFromLY(candidate.distanceLY),
    detail: {
      mainRouteName: candidate.mainRouteName,
      distanceLY: candidate.distanceLY,
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
