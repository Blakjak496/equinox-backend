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
// an admin via the Build Structures admin page.
//
// structureTypeId/rigTypeIds reference real EVE types (-> IndustryBonusType,
// see models/IndustryBonusType.ts) rather than storing bonus numbers
// directly - the admin only needs to know *what's physically fitted*
// (readable off the structure in-game), the actual bonus values are looked
// up live from real SDE data at resolve time (services/buildResolver.ts),
// category-scoped per item and combined with EVE's real stacking penalty
// (services/industryBonus.ts). A flat admin-typed % was tried in v1 and
// found to be wrong - rig bonuses only apply to specific production
// categories, so one flat number can't be correct for everything a
// structure builds.
export interface IIndustryProfile {
  activity: "manufacturing" | "reaction" | "research" | "copying" | "invention";
  structureTypeId: number; // -> IndustryBonusType (kind: "structure")
  rigTypeIds: number[]; // -> IndustryBonusType (kind: "rig"), each a real fitted rig
  // Facility tax rate (%) the structure owner has set in-game - not
  // derivable from SDE/ESI, feeds into the EIV-based job cost formula
  // alongside the fixed SCC surcharge (see buildResolver.ts).
  facilityTaxPercent: number;
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
    structureTypeId: { type: Number, required: true },
    rigTypeIds: { type: [Number], default: [] },
    facilityTaxPercent: { type: Number, required: true, default: 0 },
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
