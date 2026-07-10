import mongoose, { Schema, Document } from "mongoose";

export interface IBuybackCategory extends Document {
  groupId: number;
  name: string;
  accepted: boolean;
  percentOffered: number;
}

const BuybackCategorySchema = new Schema<IBuybackCategory>(
  {
    groupId: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
    accepted: { type: Boolean, required: true, default: false },
    percentOffered: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

export const BuybackCategory = mongoose.model<IBuybackCategory>(
  "BuybackCategory",
  BuybackCategorySchema,
);
