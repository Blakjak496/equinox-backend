import mongoose, { Schema, Document } from "mongoose";

export interface IJaniceRef {
  appraisalCode: string;
  appraisalId: number;
  expires: Date;
  pricingVariant: "immediate" | "top5Average" | "effective";
}

export interface IQuote extends Document {
  quoteId: string;
  origin: string;
  destination: string;
  volumeM3: number;
  collateral: number;
  isRush: boolean;
  rushRate: number;
  reward: number;
  janice: IJaniceRef | null;
  expiresAt: Date;
}

const JaniceRefSchema = new Schema<IJaniceRef>(
  {
    appraisalCode: { type: String, required: true },
    appraisalId: { type: Number, required: true },
    expires: { type: Date, required: true },
    pricingVariant: {
      type: String,
      enum: ["immediate", "top5Average", "effective"],
      required: true,
    },
  },
  { _id: false },
);

const QuoteSchema = new Schema<IQuote>(
  {
    quoteId: { type: String, required: true, unique: true },
    origin: { type: String, required: true },
    destination: { type: String, required: true },
    volumeM3: { type: Number, required: true },
    collateral: { type: Number, required: true },
    isRush: { type: Boolean, default: false },
    rushRate: { type: Number, required: true },
    reward: { type: Number, required: true },
    janice: { type: JaniceRefSchema, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

export const Quote = mongoose.model<IQuote>("Quote", QuoteSchema);
