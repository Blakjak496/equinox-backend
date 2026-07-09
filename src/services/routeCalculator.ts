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
  // What the customer is billed on: the actual one-way distance their
  // cargo travels from pickup to dropoff via this route.
  distanceLY: number;
  // What this delivery actually costs *me* to service - the extra flying
  // beyond whatever I'd already be doing regardless of this delivery.
  // Used only to pick the cheapest anchor/insertion and to rank this
  // candidate against other main routes and against a dedicated direct
  // trip - never billed to the customer, since a detour's whole appeal is
  // that it costs me less to fly than a dedicated round trip even though
  // the customer still pays for the full distance travelled.
  rankingCostLY: number;
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
      // freighter flies between them regardless of this delivery, so it
      // costs nothing extra to service (this always wins any comparison).
      // Billed distance is the route's own sub-segment between the two
      // waypoints, in whichever order they appear (this route may be
      // flown either direction).
      const path = orderedRideSegment(waypoints, pickupIndex, dropoffIndex);

      bestForThisRoute = {
        distanceLY: rideAlongLY(waypoints, pickupIndex, dropoffIndex),
        rankingCostLY: 0,
        mainRouteName: mainRoute.name,
        path: path.map((s) => s.name),
      };
    } else if (pickupOnRoute !== dropoffOnRoute) {
      // Exactly one point is already a scheduled waypoint - the freighter
      // rides the route (already flying that regardless, at no extra cost
      // to me) from that waypoint to some anchor, then spurs off to the
      // off-route point and back before resuming the route. The anchor
      // that's cheapest *for me* is whichever minimises that round-trip
      // spur alone - the ride-along portion doesn't factor in, since I'm
      // flying it either way. The customer is billed differently though:
      // the actual one-way distance their cargo travels (ride + one-way
      // spur, no return leg, since the cargo isn't in the hold on the way
      // back).
      const onRouteIndex = pickupOnRoute ? pickupIndex : dropoffIndex;
      const toOffRoutePoint = pickupOnRoute ? toDropoff : toPickup;

      for (let k = 0; k < waypoints.length; k++) {
        const spurLY = legDistance(toOffRoutePoint[k]);
        if (spurLY === null) continue;

        const rankingCostLY = 2 * spurLY;

        if (!bestForThisRoute || rankingCostLY < bestForThisRoute.rankingCostLY) {
          const spurPath = legPath(toOffRoutePoint[k])!;
          const distanceLY = rideAlongLY(waypoints, onRouteIndex, k) + spurLY;

          const path = pickupOnRoute
            ? [...orderedRideSegment(waypoints, pickupIndex, k), ...spurPath.slice(1)]
            : [
                ...reversed(spurPath),
                ...orderedRideSegment(waypoints, k, dropoffIndex).slice(1),
              ];

          bestForThisRoute = {
            distanceLY,
            rankingCostLY,
            mainRouteName: mainRoute.name,
            path: path.map((s) => s.name),
          };
        }
      }
    } else {
      // Neither point is on the route - servicing this delivery means
      // genuinely detouring off the spine to reach both ends before
      // rejoining it, so what it costs *me* is that detour's overhead
      // beyond the spine segment it's replacing (j is always i + 1, the
      // route's own waypoints aren't optional stops to skip over). If no
      // main route's overhead beats a dedicated round trip, this is really
      // just a direct delivery in disguise - there's nothing "on the way"
      // to leverage. The customer's bill, though, is simply the direct
      // pickup -> dropoff distance regardless of which gap it's slotted
      // into, since that's the cargo's actual one-way journey.
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
          rankingCostLY: bestInsertion.overheadLY,
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

  type RankedOption = { rankingCostLY: number; option: RouteCostOption };

  const ranked: RankedOption[] = detourCandidates.map((candidate) => ({
    rankingCostLY: candidate.rankingCostLY,
    option: {
      mode: "detour",
      pricePerM3: candidate.distanceLY * PRICE_PER_M3_PER_LY,
      minimum: minimumFromLY(candidate.distanceLY),
      detail: {
        mainRouteName: candidate.mainRouteName,
        distanceLY: candidate.distanceLY,
        path: candidate.path,
      },
    },
  }));

  if (directRoundTripLY !== null && directMinimum !== null) {
    // Direct has no baseline to net out against - the whole round trip is
    // the extra flying it costs me, same as what the customer is billed.
    ranked.push({
      rankingCostLY: directRoundTripLY,
      option: {
        mode: "direct",
        pricePerM3: directRoundTripLY * PRICE_PER_M3_PER_LY,
        minimum: directMinimum,
        detail: {
          directRoundTripLY,
        },
      },
    });
  }

  if (ranked.length === 0) {
    return {
      error:
        "No dedicated direct round trip is possible (can't jump back into a high-sec endpoint), and no detour off an active main route is viable.",
    };
  }

  ranked.sort((a, b) => a.rankingCostLY - b.rankingCostLY);

  // If direct costs me the least to actually fly (or it's the only
  // option), none of the main routes are genuinely useful for this
  // delivery - there's no real choice to make, so just return it on its
  // own rather than presenting a "choice" of one.
  if (ranked[0].option.mode === "direct") {
    return { suggestChargeCollateral, options: [ranked[0].option] };
  }

  return { suggestChargeCollateral, options: ranked.map((r) => r.option) };
}
