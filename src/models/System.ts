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
  hasTetherableStructure: boolean;
}

const SystemSchema = new Schema<ISystem>(
  {
    systemId: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
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
    hasTetherableStructure: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

export const System = mongoose.model<ISystem>("System", SystemSchema);
