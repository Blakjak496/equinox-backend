import mongoose, { Schema, Document } from "mongoose";

interface IPosition {
  x: number;
  y: number;
  z: number;
}

export interface IStructure extends Document {
  structureId: number;
  access: "ok" | "forbidden";
  name: string | null;
  ownerId: number | null;
  systemId: number | null;
  systemName: string | null;
  typeId: number | null;
  typeName: string | null;
  position: IPosition | null;
  lastError: string | null;
}

const StructureSchema = new Schema<IStructure>(
  {
    structureId: { type: Number, required: true, unique: true },
    access: { type: String, enum: ["ok", "forbidden"], required: true },
    name: { type: String, default: null },
    ownerId: { type: Number, default: null },
    systemId: { type: Number, default: null },
    systemName: { type: String, default: null },
    typeId: { type: Number, default: null },
    typeName: { type: String, default: null },
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
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

export const Structure = mongoose.model<IStructure>(
  "Structure",
  StructureSchema,
);
