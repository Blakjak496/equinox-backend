import mongoose, { Schema, Document, Types } from "mongoose";

// Raw ESI history entry shape, stored verbatim rather than pre-picked down
// to {date, volume} - avgVolume/stdDev are still derived from .volume at
// compute time, but average/highest/lowest/order_count are kept too.
export interface IBuybackItemHistoryEntry {
  date: string;
  average: number;
  highest: number;
  lowest: number;
  order_count: number;
  volume: number;
}

export interface IBuybackItem extends Document {
  typeId: number;
  name: string;
  categoryId: Types.ObjectId;
  // null means "inherit from category" - explicit true/false overrides it
  accepted: boolean | null;
  // null means "inherit from category rate"
  rateOverride: number | null;
  notes: string | null;
  // null means "inherit from category" for all three of these
  variable: boolean | null;
  haulable: boolean | null;
  acceptedLocationIds: string[] | null;
  // static SDE data, fetched once and cached permanently (never refreshed)
  packagedVolume: number | null;
  // cached pricing-recommendation-engine inputs/outputs, computed nightly -
  // null until the first run has processed this item
  avgVolume: number | null;
  stdDev: number | null;
  sActive: number | null;
  // V_D / M_x - stored for future debugging, not surfaced in the admin UI
  demandVelocity: number | null;
  marketMultiplier: number | null;
  // FinalOffer as a percent (e.g. 82.8), matching percentOffered/rateOverride
  recommendedRate: number | null;
  recommendedRateUpdatedAt: Date | null;
  // rolling 30-day series of full ESI history entries, fully replaced each
  // nightly run
  dailyVolumeHistory: IBuybackItemHistoryEntry[];
  // true when recommendedRate differs from the active rate and hasn't been
  // actioned (accepted or explicitly ignored) yet
  recommendationPending: boolean;
  // the specific recommendedRate value last dismissed via "Ignore" - lets
  // the batch job avoid re-flagging the same recommendation every night
  dismissedRecommendedRate: number | null;
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
    variable: { type: Boolean, default: null },
    haulable: { type: Boolean, default: null },
    acceptedLocationIds: { type: [String], default: null },
    packagedVolume: { type: Number, default: null },
    avgVolume: { type: Number, default: null },
    stdDev: { type: Number, default: null },
    sActive: { type: Number, default: null },
    demandVelocity: { type: Number, default: null },
    marketMultiplier: { type: Number, default: null },
    recommendedRate: { type: Number, default: null },
    recommendedRateUpdatedAt: { type: Date, default: null },
    dailyVolumeHistory: {
      type: [
        {
          date: String,
          average: Number,
          highest: Number,
          lowest: Number,
          order_count: Number,
          volume: Number,
          _id: false,
        },
      ],
      default: [],
    },
    recommendationPending: { type: Boolean, required: true, default: false },
    dismissedRecommendedRate: { type: Number, default: null },
  },
  { timestamps: true },
);

export const BuybackItem = mongoose.model<IBuybackItem>(
  "BuybackItem",
  BuybackItemSchema,
);
