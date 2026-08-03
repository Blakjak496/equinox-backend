import mongoose, { Schema, Document } from "mongoose";

// One doc per issued refresh-handle generation. A "family" (familyId) is
// one continuous login - rotating (on every /tools-auth/refresh) revokes
// the current doc and inserts the next generation with the same familyId
// and sessionStartedAt, so the family's age can be checked without walking
// its history. Presenting an already-revoked doc's handle is a reuse signal
// (see toolsAuth.ts's rotateSession) - the whole family gets revoked.
export interface IToolsSession extends Document {
  familyId: string;
  characterId: string;
  refreshHandleHash: string;
  eveRefreshTokenEncrypted: string;
  sessionStartedAt: Date;
  revoked: boolean;
  createdAt: Date;
}

const ToolsSessionSchema = new Schema<IToolsSession>(
  {
    familyId: { type: String, required: true, index: true },
    characterId: { type: String, required: true, index: true },
    refreshHandleHash: { type: String, required: true, unique: true },
    eveRefreshTokenEncrypted: { type: String, required: true },
    sessionStartedAt: { type: Date, required: true },
    revoked: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

export const ToolsSession = mongoose.model<IToolsSession>(
  "ToolsSession",
  ToolsSessionSchema,
);
