import { IReprocessingMaterial } from "../models/ReprocessingMaterial";

// Rates already account for the corp's actual skills/implants/structure -
// not derived from SDE data, which only has the unmodified 50% base.
export const REPROCESSING_EFFICIENCY: Record<
  "ore_ice" | "gas" | "scrap",
  number
> = {
  ore_ice: 0.9063,
  gas: 0.95,
  scrap: 0.55,
};

export type ReprocessingYield = {
  batches: number;
  // units left over that don't fill a full portionSize batch - priced at
  // the item's own normal buy value, not reprocessed
  remainder: number;
  materials: { materialTypeId: number; materialName: string; quantity: number }[];
};

// Only whole batches (portionSize units) get reprocessed - the leftover
// remainder is priced as the raw item itself by the caller.
export function calculateReprocessingYield(
  data: IReprocessingMaterial,
  quantity: number,
  efficiency: number,
): ReprocessingYield {
  const batches = Math.floor(quantity / data.portionSize);
  const remainder = quantity - batches * data.portionSize;

  const materials = data.materials.map((material) => ({
    materialTypeId: material.materialTypeId,
    materialName: material.materialName,
    quantity: Math.floor(material.quantity * batches * efficiency),
  }));

  return { batches, remainder, materials };
}
