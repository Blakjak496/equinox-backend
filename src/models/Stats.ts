import mongoose, { Schema, Document } from "mongoose";

export interface IStats extends Document {
  avgCompletionSeconds7d: number | null;
  completedTotal: number;
  inProgressCount: number;
  outstandingCount: number;
  revenueLifetime: number;
}

const StatsSchema = new Schema<IStats>(
  {
    avgCompletionSeconds7d: { type: Number, default: null },
    completedTotal: { type: Number, default: 0 },
    inProgressCount: { type: Number, default: 0 },
    outstandingCount: { type: Number, default: 0 },
    revenueLifetime: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const Stats = mongoose.model<IStats>("Stats", StatsSchema);
