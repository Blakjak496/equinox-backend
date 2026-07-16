import mongoose, { Schema, Document } from "mongoose";

export interface IBuybackLocation extends Document {
  name: string;
  isHub: boolean;
  distance: number;
  // ISK charged per m3 of fee-eligible volume to collect a contract from
  // this location and bring it back to the hub - only set for locations
  // that offer a pickup service. Charging per m3 (rather than a flat
  // per-trip fee) means the charge scales with how many trips are actually
  // needed to clear a contract. Null means no pickup fee is charged (and
  // the fee is omitted from quotes entirely), which is always the case for
  // hubs since the items are already there.
  pickupRatePerM3: number | null;
  // EVE station/structure ID identifying where this location's Division 6
  // corp hangar (the resale stock hangar) physically is, for corpAssetSync
  // to poll against. Set by picking from the existing Structure/Station
  // cache (see admin GET /admin/structures/search) rather than typed in
  // blind - only locations that actually hold sellable stock need this.
  stockLocationId: number | null;
  // Denormalized display copies of the name/system captured at the moment
  // the admin picked the structure/station from search results - avoids a
  // second lookup just to render a human-readable label in the admin UI.
  stockLocationName: string | null;
  stockLocationSystemName: string | null;
}

const BuybackLocationSchema = new Schema<IBuybackLocation>(
  {
    name: { type: String, required: true, unique: true },
    isHub: { type: Boolean, required: true, default: false },
    distance: { type: Number, required: true },
    pickupRatePerM3: { type: Number, default: null },
    stockLocationId: { type: Number, default: null },
    stockLocationName: { type: String, default: null },
    stockLocationSystemName: { type: String, default: null },
  },
  { timestamps: true },
);

export const BuybackLocation = mongoose.model<IBuybackLocation>(
  "BuybackLocation",
  BuybackLocationSchema,
);
