import mongoose, { Schema, Document } from "mongoose";

export interface EsiCorporation {
  alliance_id: number;
  ceo_id: number;
  creator_id: number;
  date_founded: string;
  description: string;
  faction_id: number;
  home_station_id: number;
  member_count: number;
  name: string;
  shares: number;
  tax_rate: number;
  ticker: string;
  url: string;
  war_eligible: true;
}

export interface ICorporation extends Document {
  corporationId: number;
  allianceId: number | null;
  name: string;
  ticker: string;
}

const CorporationSchema = new Schema<ICorporation>(
  {
    corporationId: { type: Number, required: true },
    allianceId: { type: Number, default: null },
    name: { type: String, required: true },
    ticker: { type: String, required: true },
  },
  { timestamps: true },
);

export const Corporation = mongoose.model<ICorporation>(
  "Corporation",
  CorporationSchema,
);
