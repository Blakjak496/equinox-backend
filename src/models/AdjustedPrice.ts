import mongoose, { Schema, Document } from "mongoose";

// ESI's universe-wide, once-daily-refreshed "adjusted price" per type -
// the basis for Estimated Item Value (EIV), and therefore industry job
// installation cost. Deliberately separate from Janice's buy/sell/split
// prices (BuildResolveResult.summary math) - EIV is a different, fixed
// reference value CCP uses purely for taxes/fees, not a tradeable market
// price. Refreshed by services/adjustedPrices.ts's daily cron job, read
// (never live-fetched) by the build resolver.
export interface IAdjustedPrice extends Document {
  typeId: number;
  adjustedPrice: number;
  averagePrice: number;
}

const AdjustedPriceSchema = new Schema<IAdjustedPrice>(
  {
    typeId: { type: Number, required: true, unique: true },
    adjustedPrice: { type: Number, required: true },
    averagePrice: { type: Number, required: true },
  },
  { timestamps: true },
);

export const AdjustedPrice = mongoose.model<IAdjustedPrice>(
  "AdjustedPrice",
  AdjustedPriceSchema,
);
