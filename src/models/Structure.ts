import mongoose, { Schema, Document } from "mongoose";

interface IPosition {
  x: number;
  y: number;
  z: number;
}

// Manufacturing-specific data for a structure that's actually used to build
// or react things - layered on top of the ESI-discovered structure cache
// rather than a separate collection, since it's the exact same physical
// structure either way. One entry per activity (a structure rigged for both
// manufacturing and reaction gets two entries here), maintained manually by
// an admin via the Build Structures admin page - structures rarely change,
// and individual corp members should never need to figure out rig bonuses
// themselves (see src/routes/toolsBuild.ts).
export interface IIndustryProfile {
  activity: "manufacturing" | "reaction" | "research" | "copying" | "invention";
  structureType: string; // Sotiyo, Azbel, Athanor, Tatara, etc.
  rigs: string[];
  securityClass: "highsec" | "lowsec" | "nullsec" | "wormhole";
  materialReduction: number | null;
  timeReduction: number | null;
  costReduction: number | null;
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
  industryProfiles: IIndustryProfile[];
}

const IndustryProfileSchema = new Schema<IIndustryProfile>(
  {
    activity: {
      type: String,
      enum: ["manufacturing", "reaction", "research", "copying", "invention"],
      required: true,
    },
    structureType: { type: String, required: true },
    rigs: { type: [String], default: [] },
    securityClass: {
      type: String,
      enum: ["highsec", "lowsec", "nullsec", "wormhole"],
      required: true,
    },
    materialReduction: { type: Number, default: null },
    timeReduction: { type: Number, default: null },
    costReduction: { type: Number, default: null },
  },
  { _id: false },
);

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
    industryProfiles: { type: [IndustryProfileSchema], default: [] },
  },
  { timestamps: true },
);

export const Structure = mongoose.model<IStructure>(
  "Structure",
  StructureSchema,
);
