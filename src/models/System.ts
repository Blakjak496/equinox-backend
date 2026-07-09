import mongoose, { Schema, Document } from "mongoose";

interface IPosition {
  x: number;
  y: number;
  z: number;
}

export interface ISystem extends Document {
  systemId: number;
  name: string;
  position: IPosition | null;
  securityStatus: number | null;
  regionId: number | null;
}

const SystemSchema = new Schema<ISystem>(
  {
    systemId: { type: Number, required: true, unique: true },
    name: { type: String, required: true, index: true },
    position: {
      type: new Schema<IPosition>(
        {
          x: { type: Number, required: true },
          y: { type: Number, required: true },
          z: { type: Number, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    securityStatus: { type: Number, default: null },
    regionId: { type: Number, default: null },
  },
  { timestamps: true },
);

export const System = mongoose.model<ISystem>("System", SystemSchema);
