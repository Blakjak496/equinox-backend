import mongoose, { Schema, Document } from "mongoose";

export interface IRouteTerms {
  maxVolume: number;
  minReward: number;
  rate: number;
  rushPrice: number;
  collateralFeePercent: number;
}

const RouteTermsSchema = new Schema<IRouteTerms>(
  {
    maxVolume: { type: Number, default: 375000 },
    minReward: { type: Number, default: 0 },
    rate: { type: Number, default: 0 },
    rushPrice: { type: Number, default: 150000000 },
    collateralFeePercent: { type: Number, default: 0 },
  },
  { _id: false },
);

const PartialRouteTermsSchema = new Schema<Partial<IRouteTerms>>(
  {
    maxVolume: { type: Number },
    minReward: { type: Number },
    rate: { type: Number },
    rushPrice: { type: Number },
    collateralFeePercent: { type: Number },
  },
  { _id: false },
);

export interface IPricingOverride {
  tier: "public" | "corp";
  terms: Partial<IRouteTerms>;
}

const PricingOverrideSchema = new Schema<IPricingOverride>(
  {
    tier: { type: String, enum: ["public", "corp"], required: true },
    terms: { type: PartialRouteTermsSchema, required: true },
  },
  { _id: false },
);

export interface IRoute extends Document {
  systems: [string, string];
  oneWay: boolean;
  terms: IRouteTerms;
}

const RouteSchema = new Schema<IRoute>(
  {
    systems: { type: [String], required: true },
    oneWay: { type: Boolean, required: true, default: false },
    terms: { type: RouteTermsSchema, required: true },
  },
  { timestamps: true },
);

export const Route = mongoose.model<IRoute>("Route", RouteSchema);
