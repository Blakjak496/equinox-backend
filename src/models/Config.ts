import mongoose, { Schema, Document } from "mongoose";

export interface IConfig extends Document {
  maxCollateral: number;
}

const ConfigSchema = new Schema<IConfig>(
  {
    maxCollateral: { type: Number, required: true },
  },
  { timestamps: true },
);

export const Config = mongoose.model<IConfig>("Config", ConfigSchema);
