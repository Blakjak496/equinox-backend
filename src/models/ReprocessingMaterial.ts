import mongoose, { Schema, Document } from "mongoose";

// Static SDE data (Fuzzworks invTypeMaterials + invTypes.portionSize),
// imported once via scripts/importReprocessingData.ts and only re-run when
// new ore/ice/gas is added to the game. Only holds entries for typeIds
// present in BuybackItem's catalog - no need to carry reprocessing data for
// every reprocessable type in the game.
export interface IReprocessingMaterialEntry {
  materialTypeId: number;
  materialName: string;
  // base yield for one full portionSize batch, before efficiency is applied
  quantity: number;
}

export interface IReprocessingMaterial extends Document {
  typeId: number;
  portionSize: number;
  materials: IReprocessingMaterialEntry[];
}

const ReprocessingMaterialSchema = new Schema<IReprocessingMaterial>(
  {
    typeId: { type: Number, required: true, unique: true },
    portionSize: { type: Number, required: true },
    materials: {
      type: [
        {
          materialTypeId: { type: Number, required: true },
          materialName: { type: String, required: true },
          quantity: { type: Number, required: true },
          _id: false,
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

export const ReprocessingMaterial = mongoose.model<IReprocessingMaterial>(
  "ReprocessingMaterial",
  ReprocessingMaterialSchema,
);
