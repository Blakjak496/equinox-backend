import mongoose, { Schema, Document } from "mongoose";

export interface IBuybackLocation extends Document {
  name: string;
  isHub: boolean;
  distance: number;
}

const BuybackLocationSchema = new Schema<IBuybackLocation>(
  {
    name: { type: String, required: true, unique: true },
    isHub: { type: Boolean, required: true, default: false },
    distance: { type: Number, required: true },
  },
  { timestamps: true },
);

export const BuybackLocation = mongoose.model<IBuybackLocation>(
  "BuybackLocation",
  BuybackLocationSchema,
);
