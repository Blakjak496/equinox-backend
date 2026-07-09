import { ISystem } from "../models/System";
import { getCachedSystems } from "../lib/systemCache";
import { distanceLY, METERS_PER_LY, Position } from "../utils/distance-utils";

const HIGH_SEC_THRESHOLD = 0.5;

export type JumpPathResult =
  | { path: ISystem[]; totalDistanceLY: number }
  | { error: string };

function isHighSec(system: ISystem): boolean {
  return (
    system.securityStatus !== null && system.securityStatus >= HIGH_SEC_THRESHOLD
  );
}

// Simple binary min-heap keyed by distance. Uses lazy deletion (stale
// entries left behind by a better distance found later are just skipped
// when popped) rather than a decrease-key operation, which is the
// standard, simplest way to implement a Dijkstra priority queue.
class MinHeap {
  private items: { systemId: number; dist: number }[] = [];

  push(systemId: number, dist: number): void {
    this.items.push({ systemId, dist });
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].dist <= this.items[index].dist) break;
      [this.items[parent], this.items[index]] = [
        this.items[index],
        this.items[parent],
      ];
      index = parent;
    }
  }

  pop(): { systemId: number; dist: number } | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      let index = 0;
      const length = this.items.length;
      while (true) {
        const left = index * 2 + 1;
        const right = index * 2 + 2;
        let smallest = index;
        if (left < length && this.items[left].dist < this.items[smallest].dist) {
          smallest = left;
        }
        if (
          right < length &&
          this.items[right].dist < this.items[smallest].dist
        ) {
          smallest = right;
        }
        if (smallest === index) break;
        [this.items[smallest], this.items[index]] = [
          this.items[index],
          this.items[smallest],
        ];
        index = smallest;
      }
    }
    return top;
  }

  get size(): number {
    return this.items.length;
  }
}

// Uniform grid keyed by cell coordinates (cell size == jump range), so a
// neighbor search only has to look at the 3x3x3 block of cells around a
// system instead of every system in the graph. Since two points within
// `jumpRangeLY` of each other can never have cell indices differing by
// more than 1 on any axis, that 3x3x3 block is always sufficient.
function cellKey(position: Position, cellSizeMeters: number): string {
  const cx = Math.floor(position.x / cellSizeMeters);
  const cy = Math.floor(position.y / cellSizeMeters);
  const cz = Math.floor(position.z / cellSizeMeters);
  return `${cx},${cy},${cz}`;
}

function buildSpatialGrid(
  systems: ISystem[],
  cellSizeMeters: number,
): Map<string, ISystem[]> {
  const grid = new Map<string, ISystem[]>();
  for (const system of systems) {
    if (!system.position) continue;
    const key = cellKey(system.position, cellSizeMeters);
    const bucket = grid.get(key);
    if (bucket) bucket.push(system);
    else grid.set(key, [system]);
  }
  return grid;
}

function nearbySystems(
  position: Position,
  grid: Map<string, ISystem[]>,
  cellSizeMeters: number,
): ISystem[] {
  const cx = Math.floor(position.x / cellSizeMeters);
  const cy = Math.floor(position.y / cellSizeMeters);
  const cz = Math.floor(position.z / cellSizeMeters);

  const candidates: ISystem[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (bucket) candidates.push(...bucket);
      }
    }
  }
  return candidates;
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

  // Already there - no jump needed, so the high-sec landing rule doesn't
  // apply (nothing is being landed *into*).
  if (start.systemId === end.systemId) {
    return { path: [start], totalDistanceLY: 0 };
  }

  if (isHighSec(end)) {
    return { error: "A jump route can't end in high-sec." };
  }

  // Any system can be a starting point, but only non-high-sec systems can
  // be landed in (except the start itself, since you can depart high-sec).
  const nodes = allSystems.filter(
    (s) => s.position && (!isHighSec(s) || s.systemId === start.systemId),
  );

  const cellSizeMeters = jumpRangeLY * METERS_PER_LY;
  const grid = buildSpatialGrid(nodes, cellSizeMeters);

  const neighborsOf = (system: ISystem): ISystem[] =>
    nearbySystems(system.position!, grid, cellSizeMeters).filter(
      (candidate) =>
        candidate.systemId !== system.systemId &&
        distanceLY(system.position!, candidate.position!) <= jumpRangeLY,
    );

  if (isHighSec(start)) {
    if (neighborsOf(start).length === 0) {
      return { error: "A jump route can't start in high-sec." };
    }
  }

  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const visited = new Set<number>();
  const queue = new MinHeap();

  dist.set(start.systemId, 0);
  queue.push(start.systemId, 0);

  while (queue.size > 0) {
    const current = queue.pop()!;
    if (visited.has(current.systemId)) continue;
    if (current.systemId === end.systemId) break;
    visited.add(current.systemId);

    const currentSystem = byId.get(current.systemId)!;
    for (const neighbor of neighborsOf(currentSystem)) {
      if (visited.has(neighbor.systemId)) continue;

      const d = distanceLY(currentSystem.position!, neighbor.position!);
      const alt = current.dist + d;

      if (alt < (dist.get(neighbor.systemId) ?? Infinity)) {
        dist.set(neighbor.systemId, alt);
        prev.set(neighbor.systemId, current.systemId);
        queue.push(neighbor.systemId, alt);
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
