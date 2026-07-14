import mongoose, { Schema, Document } from "mongoose";

// Raw ESI sell-order shape (buy orders are filtered out of the sweep before
// this ever gets built), stored verbatim rather than pre-aggregated.
export interface IBuybackMarketSnapshotOrder {
  order_id: number;
  is_buy_order: boolean;
  duration: number;
  issued: string;
  location_id: number;
  min_volume: number;
  price: number;
  range: string;
  system_id: number;
  type_id: number;
  volume_remain: number;
  volume_total: number;
}

// One document per item per pricing-engine run, purely a raw-data retention
// trail (not read back by the engine itself, which always recomputes live).
// Auto-purged 31 days after creation via the TTL index below.
export interface IBuybackMarketSnapshot extends Document {
  typeId: number;
  // still stored as a convenience field (sum of orders[].volume_remain) so
  // sActive can be read without re-summing the raw order array
  sActive: number;
  orders: IBuybackMarketSnapshotOrder[];
  expiresAt: Date;
}

const BuybackMarketSnapshotOrderSchema = new Schema<IBuybackMarketSnapshotOrder>(
  {
    order_id: Number,
    is_buy_order: Boolean,
    duration: Number,
    issued: String,
    location_id: Number,
    min_volume: Number,
    price: Number,
    range: String,
    system_id: Number,
    type_id: Number,
    volume_remain: Number,
    volume_total: Number,
  },
  { _id: false },
);

const BuybackMarketSnapshotSchema = new Schema<IBuybackMarketSnapshot>(
  {
    typeId: { type: Number, required: true, index: true },
    sActive: { type: Number, required: true },
    orders: { type: [BuybackMarketSnapshotOrderSchema], default: [] },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

BuybackMarketSnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BuybackMarketSnapshot = mongoose.model<IBuybackMarketSnapshot>(
  "BuybackMarketSnapshot",
  BuybackMarketSnapshotSchema,
);
