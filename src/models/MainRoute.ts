import mongoose, { Schema, Document } from "mongoose";

export interface IMainRoute extends Document {
  name: string;
  waypoints: number[];
  active: boolean;
}

const MainRouteSchema = new Schema<IMainRoute>(
  {
    name: { type: String, required: true },
    waypoints: { type: [Number], required: true },
    active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

export const MainRoute = mongoose.model<IMainRoute>(
  "MainRoute",
  MainRouteSchema,
);
