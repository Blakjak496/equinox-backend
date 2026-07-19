import mongoose, { Schema, Document } from "mongoose";

export interface IBuyOrderItem {
  typeId: number;
  name: string;
  quantity: number;
  // locked at order time, never re-priced
  unitPrice: number;
  totalPrice: number;
}

export interface IBuyOrder extends Document {
  referenceId: string;
  customerCharacterName: string;
  // The whole order is scoped to one hub location - stock at another
  // location can't fill it without an extra shipping cost, so there's no
  // per-item location split.
  locationId: string;
  locationName: string;
  items: IBuyOrderItem[];
  totalPrice: number;
  status: "pending_contract" | "contract_created" | "completed" | "cancelled";
  matchedContractId: number | null;
  // set only on the transition to "completed" - used by the live
  // available-quantity calc (see BuybackItem) to avoid double-counting
  // against the next corpAssetSync poll
  completedAt: Date | null;
  // The Discord message posted at order-creation time - kept so later
  // status transitions (contract matched/completed/cancelled) can edit that
  // same message instead of leaving it permanently looking like a new order.
  discordMessageId: string | null;
}

const BuyOrderItemSchema = new Schema<IBuyOrderItem>(
  {
    typeId: { type: Number, required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    totalPrice: { type: Number, required: true },
  },
  { _id: false },
);

const BuyOrderSchema = new Schema<IBuyOrder>(
  {
    referenceId: { type: String, required: true, unique: true },
    customerCharacterName: { type: String, required: true },
    locationId: { type: String, required: true },
    locationName: { type: String, required: true },
    items: { type: [BuyOrderItemSchema], default: [] },
    totalPrice: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending_contract", "contract_created", "completed", "cancelled"],
      required: true,
      default: "pending_contract",
    },
    matchedContractId: { type: Number, default: null },
    completedAt: { type: Date, default: null },
    discordMessageId: { type: String, default: null },
  },
  { timestamps: true },
);

export const BuyOrder = mongoose.model<IBuyOrder>("BuyOrder", BuyOrderSchema);
