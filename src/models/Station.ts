import mongoose, { Schema, Document } from "mongoose";

interface IStationPosition {
  x: number;
  y: number;
  z: number;
}

const PositionSchema = new Schema<IStationPosition>(
  {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    z: { type: Number, required: true },
  },
  { _id: false },
);

export interface IStation extends Document {
  stationId: number;
  name: string | null;
  ownerId: number | null;
  systemId: number | null;
  systemName: string | null;
  typeId: number | null;
  typeName: string | null;
  position: IStationPosition | null;
  lastError: string | null;
}

const StationSchema = new Schema<IStation>(
  {
    stationId: { type: Number, required: true, unique: true },
    name: { type: String, default: null },
    ownerId: { type: Number, default: null },
    systemId: { type: Number, default: null },
    systemName: { type: String, default: null },
    typeId: { type: Number, default: null },
    typeName: { type: String, default: null },
    position: {
      type: PositionSchema,
      default: null,
    },
    lastError: { type: String, default: null },
  },
  {
    timestamps: true,
  },
);

export const Station = mongoose.model("Station", StationSchema);
