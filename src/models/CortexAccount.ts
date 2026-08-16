import mongoose, { Schema, Document } from "mongoose";

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
