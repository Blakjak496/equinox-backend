import mongoose, { Schema, Document } from "mongoose";

export interface IConfig extends Document {
  maxCollateral: number;
  isotopePrice: number;
  salesTaxRate: number;
}

const ConfigSchema = new Schema<IConfig>(
  {
    maxCollateral: { type: Number, required: true },
    isotopePrice: { type: Number, required: true, default: 650 },
    salesTaxRate: { type: Number, required: true, default: 0.042 },
  },
  { timestamps: true },
);

export const Config = mongoose.model<IConfig>("Config", ConfigSchema);
