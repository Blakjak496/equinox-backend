import mongoose, { Schema, Document } from "mongoose";

// An Ansiblex jump bridge's in-game name encodes both endpoint systems
// ("SystemA » SystemB - Name"), but the structure is physically deployed in
// only one of them - that's homeSystemName/homeSystemId, confirmed directly
// from ESI's own structure lookup (authoritative, not guessed). remoteSystemName
// is the other captured name, just text from the display name, resolved
// separately via getSystemIdByName - see jumpBridgeDiscovery.ts.
export interface IJumpBridge extends Document {
  structureId: number;
  name: string;
  homeSystemName: string;
  homeSystemId: number;
  remoteSystemName: string;
  remoteSystemId: number | null;
}

const JumpBridgeSchema = new Schema<IJumpBridge>(
  {
    structureId: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
    homeSystemName: { type: String, required: true },
    homeSystemId: { type: Number, required: true },
    remoteSystemName: { type: String, required: true },
    remoteSystemId: { type: Number, default: null },
  },
  { timestamps: true },
);

export const JumpBridge = mongoose.model<IJumpBridge>(
  "JumpBridge",
  JumpBridgeSchema,
);
