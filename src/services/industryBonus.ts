// EVE's real "diminishing returns" stacking penalty formula - well-
// documented, universal across every stacking-penalized attribute in the
// game, not specific to industry. The Nth-strongest of several bonuses
// affecting the same attribute only contributes at this fraction of its
// stated value (0-indexed rank: 0 = strongest = 100%, 1 ≈ 86.9%,
// 2 ≈ 57.1%, 3 ≈ 28.3%, tapering to near-zero beyond that).
const STACKING_PENALTY_DIVISOR = 2.22292081;

function stackingPenaltyAt(rank: number): number {
  return Math.exp(-((rank / STACKING_PENALTY_DIVISOR) ** 2));
}

// Combines multiple percent bonuses of the *same* type (e.g. two material-
// efficiency rigs both applicable to the same production category) with
// EVE's real stacking penalty applied, strongest first. Returns a
// multiplier (e.g. 0.95 for a net -5%), not a percent, so it chains
// directly into a quantity/cost calculation.
export function combineStackingPenalizedMultiplier(bonusPercents: number[]): number {
  const sorted = [...bonusPercents].sort((a, b) => Math.abs(b) - Math.abs(a));
  return sorted.reduce((multiplier, bonusPercent, rank) => {
    const penalized = (bonusPercent / 100) * stackingPenaltyAt(rank);
    return multiplier * (1 + penalized);
  }, 1);
}

// A structure's own flat bonus (always applies, no stacking penalty vs
// itself) combined multiplicatively with its fitted rigs' bonuses for one
// category (stacking-penalized against each other, per
// combineStackingPenalizedMultiplier above). This is the one function the
// resolver actually calls - see buildResolver.ts.
export function combineStructureAndRigMultiplier(
  structurePercent: number | null,
  rigPercents: number[],
): number {
  const structureMultiplier = 1 + (structurePercent ?? 0) / 100;
  const rigMultiplier = combineStackingPenalizedMultiplier(rigPercents);
  return structureMultiplier * rigMultiplier;
}
