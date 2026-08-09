import { Type } from "../models/Type";
import { IndustryCategory } from "../types/industryCategory";

// Classifies a blueprint's PRODUCT into the same category taxonomy the
// industry rigs use (see types/industryCategory.ts), so the resolver knows
// which of a structure's fitted rigs (if any) applies to the item actually
// being built. Verified against the real SDE (invGroups.csv/invCategories.csv)
// - every groupId below corresponds to a real EVE group, matched against
// the exact category descriptions confirmed on real rig types (see
// seedIndustryBonuses.ts's header comment).
//
// This is necessarily a best-effort, hand-built table rather than an
// exhaustive classification of every group in New Eden - an unmatched
// group returns null, which the resolver treats as "no rig bonus applies"
// (the structure's own flat bonus and ME still apply) rather than
// guessing wrong. Fine for a tool covering a corp's actual production
// chains, not a general-purpose EVE ship encyclopedia.

// Ship hull-size groups (categoryID 6 = Ship), split T1 ("basic") vs
// T2/T3 ("advanced") - each Tech tier already has its own dedicated SDE
// group (e.g. "Assault Frigate" is a separate group from "Frigate"), so no
// separate meta-level lookup is needed for ships.
const SHIP_GROUP_CATEGORY: Record<number, IndustryCategory> = {
  // -- small hull (frigate/destroyer/shuttle tier) --
  25: "basic_small_ship", // Frigate
  420: "basic_small_ship", // Destroyer
  31: "basic_small_ship", // Shuttle
  237: "basic_small_ship", // Corvette
  1283: "basic_small_ship", // Expedition Frigate
  324: "advanced_small_ship", // Assault Frigate
  830: "advanced_small_ship", // Covert Ops
  831: "advanced_small_ship", // Interceptor
  893: "advanced_small_ship", // Electronic Attack Ship
  834: "advanced_small_ship", // Stealth Bomber
  1527: "advanced_small_ship", // Logistics Frigate
  541: "advanced_small_ship", // Interdictor
  1534: "advanced_small_ship", // Command Destroyer
  1305: "advanced_small_ship", // Tactical Destroyer

  // -- medium hull (cruiser/battlecruiser tier) --
  26: "basic_medium_ship", // Cruiser
  419: "basic_medium_ship", // Combat Battlecruiser
  1201: "basic_medium_ship", // Attack Battlecruiser
  28: "basic_medium_ship", // Hauler
  463: "basic_medium_ship", // Mining Barge
  358: "advanced_medium_ship", // Heavy Assault Cruiser
  894: "advanced_medium_ship", // Heavy Interdiction Cruiser
  832: "advanced_medium_ship", // Logistics
  833: "advanced_medium_ship", // Force Recon Ship
  906: "advanced_medium_ship", // Combat Recon Ship
  540: "advanced_medium_ship", // Command Ship
  963: "advanced_medium_ship", // Strategic Cruiser
  543: "advanced_medium_ship", // Exhumer
  380: "advanced_medium_ship", // Deep Space Transport
  1202: "advanced_medium_ship", // Blockade Runner

  // -- large hull (battleship/industrial tier) --
  27: "basic_large_ship", // Battleship
  513: "basic_large_ship", // Freighter
  941: "basic_large_ship", // Industrial Command Ship
  900: "advanced_large_ship", // Marauder
  898: "advanced_large_ship", // Black Ops
  902: "advanced_large_ship", // Jump Freighter
  381: "advanced_large_ship", // Elite Battleship

  // -- capital --
  30: "capital_ship", // Titan
  485: "capital_ship", // Dreadnought
  547: "capital_ship", // Carrier
  659: "capital_ship", // Supercarrier
  883: "capital_ship", // Capital Industrial Ship
  1538: "capital_ship", // Force Auxiliary
  4594: "capital_ship", // Lancer Dreadnought
  5120: "capital_ship", // Command Carrier
};

// Component/material groups (categoryID 17 = Commodity, mostly) - matched
// against the exact real rig category descriptions confirmed live.
const COMPONENT_GROUP_CATEGORY: Record<number, IndustryCategory> = {
  334: "advanced_component", // Construction Components (T2 ship components)
  873: "basic_capital_component", // Capital Construction Components
  536: "structure", // Structure Components
  // 913 "Advanced Capital Construction Components" intentionally omitted -
  // no real rig covers that category (confirmed - see seedIndustryBonuses.ts).

  // -- reaction products --
  429: "composite_reaction", // Composite (T2 reaction output materials)
  974: "hybrid_reaction", // Hybrid Polymers (T3 reaction output materials)
  712: "biochemical_reaction", // Biochemical Material
  1136: "any_reaction", // Fuel Block (basic/T1 reaction - no dedicated rig tier)
};

// Whole invCategories map to one bonus category regardless of sub-group.
const CATEGORY_ID_CATEGORY: Record<number, IndustryCategory> = {
  8: "ammunition", // Charge
  18: "drone_and_fighter", // Drone
  87: "drone_and_fighter", // Fighter
  7: "equipment", // Module
  65: "structure", // Structure (building an Upwell structure itself)
};

export async function classifyProductCategory(
  productTypeId: number,
): Promise<IndustryCategory | null> {
  const type = await Type.findOne({ typeId: productTypeId })
    .select("groupId categoryId")
    .lean();
  if (!type) return null;

  if (type.groupId != null) {
    if (SHIP_GROUP_CATEGORY[type.groupId]) return SHIP_GROUP_CATEGORY[type.groupId];
    if (COMPONENT_GROUP_CATEGORY[type.groupId]) return COMPONENT_GROUP_CATEGORY[type.groupId];
  }

  if (type.categoryId != null && CATEGORY_ID_CATEGORY[type.categoryId]) {
    return CATEGORY_ID_CATEGORY[type.categoryId];
  }

  return null;
}
