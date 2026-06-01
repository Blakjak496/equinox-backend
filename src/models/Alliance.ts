import mongoose, { Schema, Document } from "mongoose";

export interface EsiAlliance {
  creator_corporation_id: number;
  creator_id: number;
  date_founded: string;
  executor_corporation_id: number;
  faction_id: number;
  name: string;
  ticker: string;
}

export interface IAlliance extends Document {
  allianceId: number;
  name: string;
  ticker: string;
}

const AllianceSchema = new Schema<IAlliance>(
  {
    allianceId: { type: Number, required: true },
    name: { type: String, required: true },
    ticker: { type: String, required: true },
  },
  { timestamps: true },
);

export const Alliance = mongoose.model<IAlliance>("Alliance", AllianceSchema);
