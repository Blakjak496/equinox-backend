import mongoose, { Schema, Document } from "mongoose";

export interface ISystem extends Document {
  systemId: number;
  name: string;
}

const SystemSchema = new Schema<ISystem>(
  {
    systemId: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
  },
  { timestamps: true },
);

export const System = mongoose.model<ISystem>("System", SystemSchema);
