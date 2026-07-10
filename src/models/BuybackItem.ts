import mongoose, { Schema, Document, Types } from "mongoose";

export interface IBuybackItem extends Document {
  typeId: number;
  name: string;
  categoryId: Types.ObjectId;
  // null means "inherit from category" - explicit true/false overrides it
  accepted: boolean | null;
  // null means "inherit from category rate"
  rateOverride: number | null;
  notes: string | null;
}

const BuybackItemSchema = new Schema<IBuybackItem>(
  {
    typeId: { type: Number, required: true, unique: true },
    name: { type: String, required: true, index: true },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: "BuybackCategory",
      required: true,
      index: true,
    },
    accepted: { type: Boolean, default: null },
    rateOverride: { type: Number, default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true },
);

export const BuybackItem = mongoose.model<IBuybackItem>(
  "BuybackItem",
  BuybackItemSchema,
);
