import mongoose, { Schema, Document } from "mongoose";

export interface EsiCharacter {
  alliance_id: number;
  birthday: string;
  bloodline_id: number;
  corporation_id: number;
  description: string;
  faction_id: number;
  gender: "male" | "female";
  name: string;
  race_id: number;
  security_status: number;
  title: string;
}

export interface ICharacter extends Document {
  characterId: number;
  allianceId: number | null;
  corporationId: number;
  name: string;
}

const CharacterSchema = new Schema<ICharacter>(
  {
    characterId: { type: Number, required: true },
    allianceId: { type: Number, default: null },
    corporationId: { type: Number, required: true },
    name: { type: String, required: true },
  },
  { timestamps: true },
);

export const Character = mongoose.model<ICharacter>(
  "Character",
  CharacterSchema,
);
