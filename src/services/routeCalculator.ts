import { ISystem } from "../models/System";
import { IMainRoute } from "../models/MainRoute";
import { ensureSystemIsCached } from "../utils/system-utils";
import { getConfig } from "../lib/config";
import { RouteCostResult } from "../types/types";
import { distanceLY } from "../utils/distance-utils";
import { findJumpPath, JumpPathResult } from "./jumpPathfinder";

const ISOTOPES_PER_LY = 3000;
const MIN_CONTRACT_BASE = 5_000_000;
const PRICE_PER_M3_PER_LY = 24.85;
// EVE's actual lowsec/nullsec boundary. Not specified numerically in the
// brief, so this is an assumption — override here if a different cutoff
// is intended for the collateral-fee rule.
const LOW_SEC_THRESHOLD = 0.5;

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
  const directRoundTripLY = 2 * directOneWayLY;
  const directMinimum = minimumFromLY(directRoundTripLY);

  let bestDetour: {
    extraLY: number;
    mainRouteName: string;
    insertBetween: [string, string];
  } | null = null;

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

    for (let i = 0; i < waypointSystems.length; i++) {
      // j must be strictly greater than i: a detour only exists when the
      // route genuinely spans two different waypoints (a segment the
      // freighter is already flying). A same-waypoint out-and-back spur
      // can never be cheaper than the plain direct round trip (by the
      // triangle inequality it can only tie, when the waypoint sits
      // exactly on the pickup-dropoff line) - direct already covers it.
      for (let j = i + 1; j < waypointSystems.length; j++) {
        const wi = waypointSystems[i]!;
        const wj = waypointSystems[j]!;

        let spineSegmentLY = 0;
        for (let k = i; k < j; k++) {
          spineSegmentLY += distanceLY(
            waypointSystems[k]!.position!,
            waypointSystems[k + 1]!.position!,
          );
        }

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

        if (!bestDetour || extraLY < bestDetour.extraLY) {
          bestDetour = {
            extraLY,
            mainRouteName: mainRoute.name,
            insertBetween: [wi.name, wj.name],
          };
        }
      }
    }
  }

  const detourMinimum = bestDetour ? minimumFromLY(bestDetour.extraLY) : null;

  const pricePerM3 = directOneWayLY * PRICE_PER_M3_PER_LY;

  const suggestChargeCollateral = !(
    pickup.securityStatus !== null &&
    pickup.securityStatus <= LOW_SEC_THRESHOLD &&
    pickup.hasTetherableStructure &&
    dropoff.securityStatus !== null &&
    dropoff.securityStatus <= LOW_SEC_THRESHOLD &&
    dropoff.hasTetherableStructure
  );

  if (detourMinimum !== null && bestDetour && detourMinimum <= directMinimum) {
    return {
      mode: "detour",
      pricePerM3,
      minimum: detourMinimum,
      suggestChargeCollateral,
      detail: {
        mainRouteName: bestDetour.mainRouteName,
        insertBetween: bestDetour.insertBetween,
        extraDistanceLY: bestDetour.extraLY,
      },
    };
  }

  return {
    mode: "direct",
    pricePerM3,
    minimum: directMinimum,
    suggestChargeCollateral,
    detail: {
      directRoundTripLY,
    },
  };
}
