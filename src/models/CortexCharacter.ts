import mongoose, { Schema, Document, Types } from "mongoose";

// One row per EVE character linked into EVE Cortex, independent of which
// real EVE account (invisible to us - SSO exposes no such concept) it
// belongs to. Distinct from the existing models/Character.ts (unrelated
// reference data used by the Tools app's jump planner) - do not conflate.
export interface ICortexCharacter extends Document {
  accountId: Types.ObjectId;
  eveCharacterId: number;
  eveCharacterName: string;
  // From the SSO JWT's `owner` claim. Checked on every token refresh - if
  // it changes, the character has been sold/transferred on CCP's side (see
  // services/cortexAuth.ts's refreshCharacterTokens).
  ownerHash: string;
  corporationId: number;
  allianceId: number | null;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: Date;
  scopes: string[];
  // Set when a refresh fails because CCP rejected the stored refresh token
  // (revoked/expired, or ownerHash changed). The background refresh job
  // skips flagged rows until the user re-links this specific character.
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
    // A character can only ever be linked to one Account - enforced here,
    // not just in application logic (see cortexAuth.ts's link conflict
    // check), so a race between two concurrent callbacks can't double-link.
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
