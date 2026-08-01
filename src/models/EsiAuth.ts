import mongoose, { Schema, Document } from "mongoose";

export interface IEsiAuth extends Document {
  refreshToken: string;
  characterId: string;
  // Not required - the doc(s) that existed before multi-character support
  // predate this field and will simply backfill it on their next reconnect,
  // no migration needed.
  characterName: string | null;
  corporationId: string;
  connectedAt: Date;
  jwtPayload: any;
  needsReconnect: boolean;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
}

const EsiAuthSchema = new Schema<IEsiAuth>(
  {
    refreshToken: { type: String, required: true },
    characterId: { type: String, required: true, unique: true },
    characterName: { type: String, default: null },
    corporationId: { type: String, required: true },
    connectedAt: { type: Date, required: true },
    jwtPayload: { type: Schema.Types.Mixed, required: true },
    needsReconnect: { type: Boolean, default: false },
    lastSyncAt: { type: Date, default: null },
    lastSyncError: { type: String, default: null },
  },
  { timestamps: true },
);

export const EsiAuth = mongoose.model<IEsiAuth>("EsiAuth", EsiAuthSchema);
