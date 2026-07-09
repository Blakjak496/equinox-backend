import mongoose, { Schema, Document } from "mongoose";

export interface IShipCategory extends Document {
  name: string;
  jumpRangeLY: number;
}

const ShipCategorySchema = new Schema<IShipCategory>(
  {
    name: { type: String, required: true, unique: true },
    jumpRangeLY: { type: Number, required: true },
  },
  { timestamps: true },
);

export const ShipCategory = mongoose.model<IShipCategory>(
  "ShipCategory",
  ShipCategorySchema,
);
