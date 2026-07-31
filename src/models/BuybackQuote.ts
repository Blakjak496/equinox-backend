import mongoose, { Schema, Document } from "mongoose";

export interface IBuybackQuoteItem {
  typeId: number;
  name: string;
  categoryName: string;
  quantity: number;
  jbvPerUnit: number;
  totalJbv: number;
  // unitVolume * quantity, sourced from ESI (cached on BuybackItem) - only
  // populated once an item has cleared every accept/location check, so
  // it's 0 for anything rejected before that point (see buybackQuote.ts)
  volume: number;
  percentOffered: number;
  offerValue: number;
  accepted: boolean;
  rejectReason: string | null;
}

export interface IBuybackQuote extends Document {
  referenceId: string;
  // Points at the single Janice appraisal, scoped to only the accepted
  // items (null if nothing was accepted) - item identification and
  // accept/reject resolution both happen locally, before Janice is ever
  // called, so it never sees anything that isn't already accepted.
  janiceUrl: string | null;
  items: IBuybackQuoteItem[];
  // accepted items only - sourced from the same appraisal janiceUrl points
  // at, not a sum of the per-item totalJbv values above (which cover every
  // submitted item, accepted or not)
  totalJbv: number;
  // gross, pre-fee sum of accepted item offer values
  totalOfferValue: number;
  blendedPercent: number;
  locationId: string;
  // denormalized so historical quotes stay readable if the location is
  // later renamed/removed
  locationName: string;
  // per-m3 pickup fee for locations with a pickupRatePerM3 set (scales with
  // fee-eligible volume); 0 when the location has no pickup service (e.g.
  // hubs)
  pickupFee: number;
  // totalOfferValue - pickupFee; the actual figure the seller is told to
  // put in the in-game contract
  netTotalPrice: number;
  status: "pending_contract" | "matched" | "expired";
  // independent of status - a matched quote's contract can still fail to
  // reconcile (wrong items/value), which is a property of the match, not
  // a different lifecycle stage
  discrepancy: boolean;
  // Specific cause codes behind `discrepancy` (e.g. "value_mismatch",
  // "missing_item:34") - set by matchBuybackContract() alongside
  // `discrepancy` itself, so the admin can see *why* a match was flagged
  // instead of just that it was. Empty when discrepancy is false.
  discrepancyReasons: string[];
  // The matched contract's own price at match time, for displaying next to
  // netTotalPrice above so a value_mismatch is visually obvious rather than
  // requiring a separate contract lookup.
  matchedContractPrice: number | null;
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
    volume: { type: Number, required: true },
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
    janiceUrl: { type: String, default: null },
    items: { type: [BuybackQuoteItemSchema], default: [] },
    totalJbv: { type: Number, required: true },
    totalOfferValue: { type: Number, required: true },
    blendedPercent: { type: Number, required: true },
    locationId: { type: String, required: true },
    locationName: { type: String, required: true },
    pickupFee: { type: Number, required: true },
    netTotalPrice: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending_contract", "matched", "expired"],
      required: true,
      default: "pending_contract",
    },
    discrepancy: { type: Boolean, required: true, default: false },
    discrepancyReasons: { type: [String], default: [] },
    matchedContractPrice: { type: Number, default: null },
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
