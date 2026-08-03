import mongoose, { Schema, Document } from "mongoose";

export interface IToolsUser extends Document {
  characterId: string;
  characterName: string | null;
  corporationId: string;
  createdAt: Date;
  lastLoginAt: Date;
}

const ToolsUserSchema = new Schema<IToolsUser>(
  {
    characterId: { type: String, required: true, unique: true },
    characterName: { type: String, default: null },
    corporationId: { type: String, required: true },
    lastLoginAt: { type: Date, required: true },
  },
  { timestamps: true },
);

export const ToolsUser = mongoose.model<IToolsUser>(
  "ToolsUser",
  ToolsUserSchema,
);
