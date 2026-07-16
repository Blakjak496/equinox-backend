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
  // null means "inherit from category" for both of these
  haul: boolean | null;
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
  // true once ESI has confirmed this typeId isn't listed on any regional
  // market ("Type not tradable on market!") - permanent per type_id, so the
  // batch job skips the history fetch entirely on future runs instead of
  // repeating a request that will always fail
  nonTradable: boolean;
  // Purchase Stock ("buy side") - tracked per location rather than pooled,
  // since stock at different hubs can't be combined to fill an order
  // without an extra shipping cost that's out of scope for this service.
  // Only locations with isHub:true AND a stockLocationId set are eligible -
  // corpAssetSync prunes any entry whose location no longer qualifies.
  stockByLocation: IBuybackItemLocationStock[];
  // Purchase Stock price source: null prices this item normally (Janice buy
  // value). Any other value reprocesses it locally (see ReprocessingMaterial
  // + reprocessing.ts) and prices the resulting minerals instead, using the
  // efficiency rate for this category. Item-level rather than a single
  // appraisal-wide setting because a mixed cart (ore/ice alongside modules)
  // can't have reprocessing applied selectively any other way - modules are
  // technically reprocessable too, so a single whole-cart toggle would
  // misprice them. Auto-set at import time from SDE category/group data
  // where that's unambiguous (ore/ice, gas); left null (admin sets
  // manually) for anything else, e.g. scrap/salvage.
  reprocessingCategory: "ore_ice" | "gas" | "scrap" | null;
}

export interface IBuybackItemLocationStock {
  locationId: Types.ObjectId;
  // denormalized so the admin/customer-facing UI doesn't need a join
  locationName: string;
  quantity: number;
  stockUpdatedAt: Date;
  // Soft 7-day "sitting around" nudge, not a hard liquidation trigger. Set
  // to now() on a 0 -> >0 transition, left untouched on top-ups (the older
  // stock is still what's aging), cleared back to null at 0.
  oldestUnsoldAcquiredAt: Date | null;
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
    haul: { type: Boolean, default: null },
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
    nonTradable: { type: Boolean, required: true, default: false },
    stockByLocation: {
      type: [
        {
          locationId: {
            type: Schema.Types.ObjectId,
            ref: "BuybackLocation",
            required: true,
          },
          locationName: { type: String, required: true },
          quantity: { type: Number, required: true },
          stockUpdatedAt: { type: Date, required: true },
          oldestUnsoldAcquiredAt: { type: Date, default: null },
          _id: false,
        },
      ],
      default: [],
    },
    reprocessingCategory: {
      type: String,
      enum: ["ore_ice", "gas", "scrap"],
      default: null,
    },
  },
  { timestamps: true },
);

export const BuybackItem = mongoose.model<IBuybackItem>(
  "BuybackItem",
  BuybackItemSchema,
);
