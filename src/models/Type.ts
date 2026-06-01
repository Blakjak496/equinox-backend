import mongoose, { Schema, Document } from "mongoose";

export interface IType extends Document {
  typeId: number;
  name: string;
}

const TypeSchema = new Schema<IType>(
  {
    typeId: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
  },
  { timestamps: true },
);

export const Type = mongoose.model<IType>("Type", TypeSchema);
