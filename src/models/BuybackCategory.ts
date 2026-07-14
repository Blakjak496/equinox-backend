import mongoose, { Schema, Document } from "mongoose";

export interface IBuybackCategory extends Document {
  groupId: number;
  name: string;
  accepted: boolean;
  percentOffered: number;
  // whether this category's volume counts toward the hauling fee - a
  // business choice (some items sell better locally), not a statement
  // about whether it's physically possible to haul
  haul: boolean;
  // null = unrestricted (accepted from every location)
  acceptedLocationIds: string[] | null;
}

const BuybackCategorySchema = new Schema<IBuybackCategory>(
  {
    groupId: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
    accepted: { type: Boolean, required: true, default: false },
    percentOffered: { type: Number, required: true, default: 0 },
    haul: { type: Boolean, required: true, default: true },
    acceptedLocationIds: { type: [String], default: null },
  },
  { timestamps: true },
);

export const BuybackCategory = mongoose.model<IBuybackCategory>(
  "BuybackCategory",
  BuybackCategorySchema,
);
