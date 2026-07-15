import mongoose, { Schema, Document } from "mongoose";

export interface IBuybackLocation extends Document {
  name: string;
  isHub: boolean;
  distance: number;
  // ISK charged per m3 of fee-eligible volume to collect a contract from
  // this location and bring it back to the hub - only set for locations
  // that offer a pickup service. Charging per m3 (rather than a flat
  // per-trip fee) means the charge scales with how many trips are actually
  // needed to clear a contract. Null means no pickup fee is charged (and
  // the fee is omitted from quotes entirely), which is always the case for
  // hubs since the items are already there.
  pickupRatePerM3: number | null;
}

const BuybackLocationSchema = new Schema<IBuybackLocation>(
  {
    name: { type: String, required: true, unique: true },
    isHub: { type: Boolean, required: true, default: false },
    distance: { type: Number, required: true },
    pickupRatePerM3: { type: Number, default: null },
  },
  { timestamps: true },
);

export const BuybackLocation = mongoose.model<IBuybackLocation>(
  "BuybackLocation",
  BuybackLocationSchema,
);
