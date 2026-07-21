import mongoose, { Schema, Document } from "mongoose";

export interface IRegion extends Document {
  regionId: number;
  name: string;
}

const RegionSchema = new Schema<IRegion>(
  {
    regionId: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
  },
  { timestamps: true },
);

export const Region = mongoose.model<IRegion>("Region", RegionSchema);
