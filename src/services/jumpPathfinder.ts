import { ISystem } from "../models/System";
import { getCachedSystems } from "../lib/systemCache";
import { distanceLY } from "../utils/distance-utils";

const HIGH_SEC_THRESHOLD = 0.5;

export type JumpPathResult =
  | { path: ISystem[]; totalDistanceLY: number }
  | { error: string };

function isHighSec(system: ISystem): boolean {
  return (
    system.securityStatus !== null && system.securityStatus >= HIGH_SEC_THRESHOLD
  );
}

export function findJumpPath(
  startSystemId: number,
  endSystemId: number,
  jumpRangeLY: number,
): JumpPathResult {
  const allSystems = getCachedSystems();
  const byId = new Map(allSystems.map((s) => [s.systemId, s]));

  const start = byId.get(startSystemId);
  const end = byId.get(endSystemId);

  if (!start?.position || !end?.position) {
    return { error: "Start or end system is missing position data" };
  }

  if (isHighSec(end)) {
    return { error: "A jump route can't end in high-sec." };
  }

  // Any system can be a starting point, but only non-high-sec systems can
  // be landed in (except the start itself, since you can depart high-sec).
  const nodes = allSystems.filter(
    (s) => s.position && (!isHighSec(s) || s.systemId === start.systemId),
  );

  if (isHighSec(start)) {
    const hasEscapeRoute = nodes.some(
      (s) =>
        s.systemId !== start.systemId &&
        distanceLY(start.position!, s.position!) <= jumpRangeLY,
    );
    if (!hasEscapeRoute) {
      return { error: "A jump route can't start in high-sec." };
    }
  }

  const dist = new Map<number, number>(nodes.map((n) => [n.systemId, Infinity]));
  const prev = new Map<number, number>();
  const visited = new Set<number>();
  dist.set(start.systemId, 0);

  for (let i = 0; i < nodes.length; i++) {
    let current: ISystem | null = null;
    let currentDist = Infinity;

    for (const node of nodes) {
      if (visited.has(node.systemId)) continue;
      const d = dist.get(node.systemId)!;
      if (d < currentDist) {
        currentDist = d;
        current = node;
      }
    }

    if (!current || current.systemId === end.systemId) break;
    visited.add(current.systemId);

    for (const neighbor of nodes) {
      if (visited.has(neighbor.systemId)) continue;
      const d = distanceLY(current.position!, neighbor.position!);
      if (d > jumpRangeLY) continue;

      const alt = currentDist + d;
      if (alt < dist.get(neighbor.systemId)!) {
        dist.set(neighbor.systemId, alt);
        prev.set(neighbor.systemId, current.systemId);
      }
    }
  }

  const totalDistanceLY = dist.get(end.systemId) ?? Infinity;
  if (totalDistanceLY === Infinity) {
    return { error: "No jump path exists within range." };
  }

  const path: ISystem[] = [end];
  let cursorId = end.systemId;
  while (cursorId !== start.systemId) {
    const prevId = prev.get(cursorId)!;
    path.unshift(byId.get(prevId)!);
    cursorId = prevId;
  }

  return { path, totalDistanceLY };
}
