import mongoose, { Schema, Document } from "mongoose";

export interface IBuybackLocation extends Document {
  name: string;
  isHub: boolean;
  distance: number;
  // LY distance from this location to its nearby hub - only set for
  // locations that offer a pickup service. Null means no pickup fee is
  // charged (and the fee is omitted from quotes entirely), which is always
  // the case for hubs since the items are already there.
  distanceFromHub: number | null;
}

const BuybackLocationSchema = new Schema<IBuybackLocation>(
  {
    name: { type: String, required: true, unique: true },
    isHub: { type: Boolean, required: true, default: false },
    distance: { type: Number, required: true },
    distanceFromHub: { type: Number, default: null },
  },
  { timestamps: true },
);

export const BuybackLocation = mongoose.model<IBuybackLocation>(
  "BuybackLocation",
  BuybackLocationSchema,
);
