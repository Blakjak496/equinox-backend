import mongoose, { Schema, Document } from "mongoose";

export interface IConfig extends Document {
  maxCollateral: number;
  isotopePrice: number;
  salesTaxRate: number;
  runnersEnabled: boolean;
  cartelEnabled: boolean;
}

const ConfigSchema = new Schema<IConfig>(
  {
    maxCollateral: { type: Number, required: true },
    isotopePrice: { type: Number, required: true, default: 650 },
    salesTaxRate: { type: Number, required: true, default: 0.042 },
    runnersEnabled: { type: Boolean, required: true, default: true },
    cartelEnabled: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

export const Config = mongoose.model<IConfig>("Config", ConfigSchema);
