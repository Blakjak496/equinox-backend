import mongoose, { Schema, Document, Types } from "mongoose";

export interface IBuybackGroup extends Document {
  groupId: number;
  categoryId: Types.ObjectId;
  name: string;
  // null on any of these four means "inherit from category" - explicit
  // values override it. Mirrors the item -> group fallback that already
  // existed before this level was inserted.
  accepted: boolean | null;
  percentOffered: number | null;
  // whether this group's volume counts toward the hauling fee - a
  // business choice (some items sell better locally), not a statement
  // about whether it's physically possible to haul
  haul: boolean | null;
  // null = inherit from category
  acceptedLocationIds: string[] | null;
}

const BuybackGroupSchema = new Schema<IBuybackGroup>(
  {
    groupId: { type: Number, required: true, unique: true },
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: "BuybackCategory",
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    accepted: { type: Boolean, default: null },
    percentOffered: { type: Number, default: null },
    haul: { type: Boolean, default: null },
    acceptedLocationIds: { type: [String], default: null },
  },
  { timestamps: true },
);

export const BuybackGroup = mongoose.model<IBuybackGroup>(
  "BuybackGroup",
  BuybackGroupSchema,
);
