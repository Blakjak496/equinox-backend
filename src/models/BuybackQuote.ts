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
  // gross, pre-fee sum of accepted item offer values
  totalOfferValue: number;
  blendedPercent: number;
  locationId: string;
  // denormalized so historical quotes stay readable if the location is
  // later renamed/removed
  locationName: string;
  // computed rate snapshot at quote time (location distance + live isotope
  // price), not a stored/editable setting
  haulingRatePerM3: number;
  haulingFee: number;
  // flat fuel-cost-only fee for locations with a distanceFromHub set; 0 when
  // the location has no pickup service (e.g. hubs)
  pickupFee: number;
  // totalOfferValue - haulingFee - pickupFee; the actual figure the seller
  // is told to put in the in-game contract
  netTotalPrice: number;
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
    locationId: { type: String, required: true },
    locationName: { type: String, required: true },
    haulingRatePerM3: { type: Number, required: true },
    haulingFee: { type: Number, required: true },
    pickupFee: { type: Number, required: true },
    netTotalPrice: { type: Number, required: true },
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
