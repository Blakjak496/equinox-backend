import mongoose, { Schema, Document } from "mongoose";

export interface IType extends Document {
  typeId: number;
  name: string;
  // SDE invGroups.groupID/categoryID - populated for types seeded by
  // seedBlueprints.ts/seedIndustryBonuses.ts, null for types cached
  // elsewhere (e.g. via ensureTypeIsCached's ESI lookups, which don't know
  // group). Used by services/industryCategory.ts to classify a blueprint's
  // product into the same category taxonomy as industry rigs - both fields
  // are seeded up front specifically so that classification is a plain DB
  // read at resolve time, never a live SDE fetch.
  groupId: number | null;
  categoryId: number | null;
}

const TypeSchema = new Schema<IType>(
  {
    typeId: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
    groupId: { type: Number, default: null },
    categoryId: { type: Number, default: null },
  },
  { timestamps: true },
);

export const Type = mongoose.model<IType>("Type", TypeSchema);
