import mongoose, { Schema, Document } from "mongoose";

// One document per item per pricing-engine run, purely a raw-data retention
// trail (not read back by the engine itself, which always recomputes live).
// Auto-purged 31 days after creation via the TTL index below.
export interface IBuybackMarketSnapshot extends Document {
  typeId: number;
  sActive: number;
  expiresAt: Date;
}

const BuybackMarketSnapshotSchema = new Schema<IBuybackMarketSnapshot>(
  {
    typeId: { type: Number, required: true, index: true },
    sActive: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

BuybackMarketSnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BuybackMarketSnapshot = mongoose.model<IBuybackMarketSnapshot>(
  "BuybackMarketSnapshot",
  BuybackMarketSnapshotSchema,
);
