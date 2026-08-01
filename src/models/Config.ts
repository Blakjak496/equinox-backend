import mongoose, { Schema, Document } from "mongoose";

export interface IConfig extends Document {
  maxCollateral: number;
  isotopePrice: number;
  salesTaxRate: number;
  // Minimum headroom (percentage points) a buyback rate must leave below
  // the post-tax ceiling - see buybackQuote.ts's margin-floor safety net.
  marginFloorPercent: number;
  runnersEnabled: boolean;
  cartelEnabled: boolean;
  // Which connected EsiAuth character each automated pipeline uses - null
  // means "fall back to whichever character is connected" (see
  // resolveCharacterIdForRole in lib/esiClient.ts), so these are safe to
  // leave unset until an admin actually needs to split them apart.
  businessCharacterId: string | null;
  structureCharacterId: string | null;
}

const ConfigSchema = new Schema<IConfig>(
  {
    maxCollateral: { type: Number, required: true },
    isotopePrice: { type: Number, required: true, default: 650 },
    salesTaxRate: { type: Number, required: true, default: 0.042 },
    marginFloorPercent: { type: Number, required: true, default: 5 },
    runnersEnabled: { type: Boolean, required: true, default: true },
    cartelEnabled: { type: Boolean, required: true, default: true },
    businessCharacterId: { type: String, default: null },
    structureCharacterId: { type: String, default: null },
  },
  { timestamps: true },
);

export const Config = mongoose.model<IConfig>("Config", ConfigSchema);
