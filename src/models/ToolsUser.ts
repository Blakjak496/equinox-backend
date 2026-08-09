import mongoose, { Schema, Document } from "mongoose";

// One default Structure (by structureId, see models/Structure.ts) per
// industry activity - what the Manufacturing Planner tool pre-fills its structure
// selects with, and auto-saves to whenever the corp member changes a
// selection there (see PUT /tools/build/structure-preference). Not a
// "loadout"/named set - just this member's current default per activity.
export interface IBuildStructurePreferences {
  manufacturing?: number;
  reaction?: number;
  research?: number;
  copying?: number;
  invention?: number;
}

export interface IToolsUser extends Document {
  characterId: string;
  characterName: string | null;
  corporationId: string;
  createdAt: Date;
  lastLoginAt: Date;
  buildStructurePreferences: IBuildStructurePreferences;
}

const BuildStructurePreferencesSchema = new Schema<IBuildStructurePreferences>(
  {
    manufacturing: { type: Number, default: undefined },
    reaction: { type: Number, default: undefined },
    research: { type: Number, default: undefined },
    copying: { type: Number, default: undefined },
    invention: { type: Number, default: undefined },
  },
  { _id: false },
);

const ToolsUserSchema = new Schema<IToolsUser>(
  {
    characterId: { type: String, required: true, unique: true },
    characterName: { type: String, default: null },
    corporationId: { type: String, required: true },
    lastLoginAt: { type: Date, required: true },
    buildStructurePreferences: {
      type: BuildStructurePreferencesSchema,
      default: () => ({}),
    },
  },
  { timestamps: true },
);

export const ToolsUser = mongoose.model<IToolsUser>(
  "ToolsUser",
  ToolsUserSchema,
);
