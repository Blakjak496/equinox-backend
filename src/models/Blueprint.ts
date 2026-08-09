import mongoose, { Schema, Document } from "mongoose";

// Derived from the SDE, loaded by src/scripts/seedBlueprints.ts (a manual
// one-off script - see that file's header). One row per producible item:
// no ME field is ever stored here - ME is a global assumption supplied per
// resolve request (see services/buildResolver.ts), and reactions can't be
// researched, so ME never applies when activity is "reaction".
export interface IBlueprintMaterial {
  typeId: number;
  quantity: number;
}

export interface IBlueprint extends Document {
  blueprintTypeId: number;
  productTypeId: number;
  activity: "manufacturing" | "reaction";
  outputQuantity: number;
  materials: IBlueprintMaterial[];
}

const BlueprintMaterialSchema = new Schema<IBlueprintMaterial>(
  {
    typeId: { type: Number, required: true },
    quantity: { type: Number, required: true },
  },
  { _id: false },
);

const BlueprintSchema = new Schema<IBlueprint>(
  {
    blueprintTypeId: { type: Number, required: true },
    // Unique per product - the resolver looks up "the" blueprint for a
    // product by productTypeId alone (findBlueprintForProduct), so a
    // product is assumed to have exactly one producing activity in
    // practice. seedBlueprints.ts logs a warning if the SDE ever has two.
    productTypeId: { type: Number, required: true, unique: true },
    activity: { type: String, enum: ["manufacturing", "reaction"], required: true },
    outputQuantity: { type: Number, required: true },
    materials: { type: [BlueprintMaterialSchema], default: [] },
  },
  { timestamps: true },
);

export const Blueprint = mongoose.model<IBlueprint>("Blueprint", BlueprintSchema);
