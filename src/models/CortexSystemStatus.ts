import mongoose, { Schema, Document } from "mongoose";

export interface ICortexSystemStatus extends Document {
  status: 1 | 2 | 3;
}

const CortexSystemStatusSchema = new Schema<ICortexSystemStatus>(
  { status: { type: Number, required: true, enum: [1, 2, 3] } },
  { timestamps: true },
);

export const CortexSystemStatus = mongoose.model<ICortexSystemStatus>(
  "CortexSystemStatus",
  CortexSystemStatusSchema,
);
