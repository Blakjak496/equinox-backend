import mongoose, { Schema, Document } from "mongoose";
import { IndustryCategory } from "../types/industryCategory";

// One doc per real EVE type that grants an industry bonus - the 5
// Engineering Complex / Refinery structure types, and every real "Standup
// ...Efficiency..." rig type. Seeded from the SDE by
// src/scripts/seedIndustryBonuses.ts, never hand-entered.
//
// All three bonus fields are normalized to **percent, negative = reduction**
// at seed time, regardless of how the SDE itself stores them - structure
// attributes are raw multipliers there (e.g. 0.99), rig attributes are
// already percent (e.g. -2.0) - so nothing downstream of this collection
// ever needs to know which unit the SDE used.
// Plain field shape, split out from the Document-extending interface below
// so callers that only ever read `.lean()` results (e.g. buildResolver.ts)
// can type against this directly - a lean result's extra `_id`/`__v` fields
// are structurally fine to assign into this, but not into a type that also
// demands the full Mongoose Document method set.
export interface IIndustryBonusTypeFields {
  typeId: number;
  name: string;
  kind: "structure" | "rig";
  activity: "manufacturing" | "reaction";
  // Empty for structures (their bonus is flat/global, not category-scoped -
  // never read). One or more entries for rigs - almost always exactly one,
  // but real "XL-Set" rigs consolidate several categories into a single
  // rig (e.g. "any ship", or "equipment and consumables" covering both
  // modules and ammo) rather than fitting one rig per category the way
  // M-Set/L-Set do, confirmed against their real SDE descriptions.
  category: IndustryCategory[];
  materialBonusPercent: number | null;
  timeBonusPercent: number | null;
  costBonusPercent: number | null;
}

export interface IIndustryBonusType extends Document, IIndustryBonusTypeFields {}

const IndustryBonusTypeSchema = new Schema<IIndustryBonusType>(
  {
    typeId: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
    kind: { type: String, enum: ["structure", "rig"], required: true },
    activity: { type: String, enum: ["manufacturing", "reaction"], required: true },
    category: { type: [String], default: [] },
    materialBonusPercent: { type: Number, default: null },
    timeBonusPercent: { type: Number, default: null },
    costBonusPercent: { type: Number, default: null },
  },
  { timestamps: true },
);

export const IndustryBonusType = mongoose.model<IIndustryBonusType>(
  "IndustryBonusType",
  IndustryBonusTypeSchema,
);
