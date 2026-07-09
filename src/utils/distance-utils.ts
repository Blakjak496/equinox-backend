const METERS_PER_LY = 9.4607e15;

export type Position = { x: number; y: number; z: number };

export function distanceLY(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / METERS_PER_LY;
}
