import mongoose, { Schema, Document } from "mongoose";

// EVE Cortex's own login entity - deliberately separate from the existing
// Tools app's ToolsUser/ToolsSession/EsiAuth (single-character, corp-gated,
// bearer-token). An Account has no EVE-side identity of its own; it only
// exists to group CortexCharacter rows that a user has chosen to link
// together, since EVE's SSO has no concept of "account" it exposes to us.
export interface ICortexAccount extends Document {
  createdAt: Date;
}

const CortexAccountSchema = new Schema<ICortexAccount>(
  {},
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const CortexAccount = mongoose.model<ICortexAccount>(
  "CortexAccount",
  CortexAccountSchema,
);
