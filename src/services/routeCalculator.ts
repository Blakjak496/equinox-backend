import { ISystem } from "../models/System";
import { IMainRoute } from "../models/MainRoute";
import { ensureSystemIsCached } from "../utils/system-utils";
import { getConfig } from "../lib/config";
import { RouteCostResult } from "../types/types";

const METERS_PER_LY = 9.4607e15;
const ISOTOPES_PER_LY = 3000;
const MIN_CONTRACT_BASE = 5_000_000;
const PRICE_PER_M3_PER_LY = 24.85;
// EVE's actual lowsec/nullsec boundary. Not specified numerically in the
// brief, so this is an assumption — override here if a different cutoff
// is intended for the collateral-fee rule.
const LOW_SEC_THRESHOLD = 0.5;

type Position = { x: number; y: number; z: number };

export function distanceLY(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / METERS_PER_LY;
}

function fuelCostPerLY(): number {
  return ISOTOPES_PER_LY * getConfig().isotopePrice;
}

function roundToNearestMillion(value: number): number {
  return Math.round(value / 1_000_000) * 1_000_000;
}

function minimumFromLY(ly: number): number {
  return roundToNearestMillion(ly * fuelCostPerLY()) + MIN_CONTRACT_BASE;
}

export async function calculateOptimalRoute(
  pickup: ISystem,
  dropoff: ISystem,
  mainRoutes: IMainRoute[],
): Promise<RouteCostResult> {
  if (!pickup.position || !dropoff.position) {
    throw new Error("Pickup/dropoff system is missing position data");
  }

  const directRoundTripLY = 2 * distanceLY(pickup.position, dropoff.position);
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

    for (let i = 0; i < waypointSystems.length; i++) {
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

        const orderingOneLY =
          distanceLY(wi.position!, pickup.position) +
          distanceLY(pickup.position, dropoff.position) +
          distanceLY(dropoff.position, wj.position!);

        const orderingTwoLY =
          distanceLY(wi.position!, dropoff.position) +
          distanceLY(dropoff.position, pickup.position) +
          distanceLY(pickup.position, wj.position!);

        const viaDetourLY = Math.min(orderingOneLY, orderingTwoLY);
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

  const pricePerM3 =
    distanceLY(pickup.position, dropoff.position) * PRICE_PER_M3_PER_LY;

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
