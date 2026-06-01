import mongoose, { Schema, Document } from "mongoose";

export interface IBotUser extends Document {
  discordUserId: string;
  characterId: string | null;
  characterName: string | null;
  registeredAt: Date | null;
  blacklisted: boolean;
  blacklistReason: string | null;
  shoppingBlocked: boolean;
  shoppingBlockReason: string | null;
}

const BotUserSchema = new Schema<IBotUser>(
  {
    discordUserId: { type: String, required: true, unique: true },
    characterId: { type: String, default: null },
    characterName: { type: String, default: null },
    registeredAt: { type: Date, default: null },
    blacklisted: { type: Boolean, default: false },
    blacklistReason: { type: String, default: null },
    shoppingBlocked: { type: Boolean, default: false },
    shoppingBlockReason: { type: String, default: null },
  },
  { timestamps: true },
);

export const BotUser = mongoose.model<IBotUser>("BotUser", BotUserSchema);
