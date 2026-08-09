// The production categories EVE's real Standup rigs are scoped to -
// verified live against the SDE (every value below corresponds to a real
// "Standup ...Efficiency..." rig type that actually exists), not assumed.
// See src/scripts/seedIndustryBonuses.ts for how rig types get classified
// into these, and src/services/industryCategory.ts for how a blueprint's
// PRODUCT gets classified into the same set at resolve time.
export const MANUFACTURING_CATEGORIES = [
  "basic_small_ship",
  "basic_medium_ship",
  "basic_large_ship",
  "advanced_small_ship",
  "advanced_medium_ship",
  "advanced_large_ship",
  "capital_ship",
  "advanced_component",
  "basic_capital_component",
  "equipment",
  "ammunition",
  "drone_and_fighter",
  "structure",
] as const;

// "any_reaction" is real too - the L-Set reactor rig gives one combined
// bonus across every reaction tier rather than a separate rig per tier
// (unlike M-Set, which splits Composite/Hybrid/Biochemical) - confirmed on
// a real "Standup L-Set Reactor Efficiency I" rig. There's no dedicated
// rig category for basic (T1) reactions at all - only "any_reaction"
// (L-Set) ever covers them.
export const REACTION_CATEGORIES = [
  "composite_reaction",
  "hybrid_reaction",
  "biochemical_reaction",
  "any_reaction",
] as const;

export type ManufacturingCategory = (typeof MANUFACTURING_CATEGORIES)[number];
export type ReactionCategory = (typeof REACTION_CATEGORIES)[number];
export type IndustryCategory = ManufacturingCategory | ReactionCategory;

export const ALL_INDUSTRY_CATEGORIES: IndustryCategory[] = [
  ...MANUFACTURING_CATEGORIES,
  ...REACTION_CATEGORIES,
];
