import mongoose, { Schema, Document } from "mongoose";

export interface IShipCategory extends Document {
  name: string;
  // Unskilled (Jump Drive Calibration 0) jump range - the actual range used
  // for planning is this multiplied up by whichever skill level the user
  // selects at plan time (see utils/jumpRange.ts), not stored here directly.
  baseRangeLY: number;
}

const ShipCategorySchema = new Schema<IShipCategory>(
  {
    name: { type: String, required: true, unique: true },
    baseRangeLY: { type: Number, required: true },
  },
  { timestamps: true },
);

export const ShipCategory = mongoose.model<IShipCategory>(
  "ShipCategory",
  ShipCategorySchema,
);
