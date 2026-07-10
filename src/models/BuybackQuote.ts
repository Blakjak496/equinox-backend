import mongoose, { Schema, Document } from "mongoose";

export interface IBuybackQuoteItem {
  typeId: number;
  name: string;
  categoryName: string;
  quantity: number;
  jbvPerUnit: number;
  totalJbv: number;
  percentOffered: number;
  offerValue: number;
  accepted: boolean;
  rejectReason: string | null;
}

export interface IBuybackQuote extends Document {
  referenceId: string;
  items: IBuybackQuoteItem[];
  totalJbv: number;
  totalOfferValue: number;
  blendedPercent: number;
  // set later by the hauling-rate tool once pickup location is known
  pickupFee: number | null;
  status: "pending_contract" | "matched" | "expired";
  // independent of status - a matched quote's contract can still fail to
  // reconcile (wrong items/value), which is a property of the match, not
  // a different lifecycle stage
  discrepancy: boolean;
  matchedContractId: number | null;
  expiresAt: Date;
}

const BuybackQuoteItemSchema = new Schema<IBuybackQuoteItem>(
  {
    typeId: { type: Number, required: true },
    name: { type: String, required: true },
    categoryName: { type: String, required: true },
    quantity: { type: Number, required: true },
    jbvPerUnit: { type: Number, required: true },
    totalJbv: { type: Number, required: true },
    percentOffered: { type: Number, required: true },
    offerValue: { type: Number, required: true },
    accepted: { type: Boolean, required: true },
    rejectReason: { type: String, default: null },
  },
  { _id: false },
);

const BuybackQuoteSchema = new Schema<IBuybackQuote>(
  {
    referenceId: { type: String, required: true, unique: true },
    items: { type: [BuybackQuoteItemSchema], default: [] },
    totalJbv: { type: Number, required: true },
    totalOfferValue: { type: Number, required: true },
    blendedPercent: { type: Number, required: true },
    pickupFee: { type: Number, default: null },
    status: {
      type: String,
      enum: ["pending_contract", "matched", "expired"],
      required: true,
      default: "pending_contract",
    },
    discrepancy: { type: Boolean, required: true, default: false },
    matchedContractId: { type: Number, default: null },
    // TTL index: document is purged once the current time passes expiresAt
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

BuybackQuoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BuybackQuote = mongoose.model<IBuybackQuote>(
  "BuybackQuote",
  BuybackQuoteSchema,
);
