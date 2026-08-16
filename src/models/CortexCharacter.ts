import mongoose, { Schema, Document, Types } from "mongoose";

export interface ICortexCharacter extends Document {
  accountId: Types.ObjectId;
  eveCharacterId: number;
  eveCharacterName: string;
  ownerHash: string;
  corporationId: number;
  allianceId: number | null;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: Date;
  scopes: string[];
  needsRelink: boolean;
  linkedAt: Date;
  lastSyncedAt: Date | null;
}

const CortexCharacterSchema = new Schema<ICortexCharacter>(
  {
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "CortexAccount",
      required: true,
      index: true,
    },
    // unique guards against a race between concurrent callbacks double-linking
    eveCharacterId: { type: Number, required: true, unique: true },
    eveCharacterName: { type: String, required: true },
    ownerHash: { type: String, required: true },
    corporationId: { type: Number, required: true },
    allianceId: { type: Number, default: null },
    accessTokenEncrypted: { type: String, required: true },
    refreshTokenEncrypted: { type: String, required: true },
    tokenExpiresAt: { type: Date, required: true },
    scopes: { type: [String], default: [] },
    needsRelink: { type: Boolean, required: true, default: false },
    linkedAt: { type: Date, required: true },
    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: false },
);

export const CortexCharacter = mongoose.model<ICortexCharacter>(
  "CortexCharacter",
  CortexCharacterSchema,
);
