import mongoose, { Schema, Document } from "mongoose";

export interface IShoppingItem {
  typeId: number;
  name: string;
  quantity: number;
  totalVolume: number;
  totalPackagedVolume: number;
  sellPriceTotal: number;
}

export interface IShoppingOrder extends Document {
  orderId: string;
  status:
    | "pending_purchase"
    | "accepted"
    | "ready_for_pickup"
    | "completed"
    | "cancelled"
    | "rejected";
  requesterDiscordUserId: string;
  requesterRegisteredCharacterName: string;
  deliveryCharacterName: string;
  pickup: string;
  destination: string;
  contractType: "normal" | "rush";
  tier: "public" | "corp";
  janiceCode: string;
  rawItemsText: string | null;
  itemValue: number;
  volumeM3: number;
  items: IShoppingItem[];
  haulingFee: number;
  shoppingFee: number;
  totalDue: number;
  acceptedByDiscordUserId: string | null;
  acceptedAt: Date | null;
  orderAlertMessageId: string | null;
  customerDmChannelId: string | null;
  customerStatusMessageId: string | null;
  customerStatusUpdatesDisabledAt: Date | null;
  readyAt: Date | null;
  notifiedReadyAt: Date | null;
  completedAt: Date | null;
  releasedAt: Date | null;
}

const ShoppingItemSchema = new Schema<IShoppingItem>(
  {
    typeId: { type: Number, required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    totalVolume: { type: Number, required: true },
    totalPackagedVolume: { type: Number, required: true },
    sellPriceTotal: { type: Number, required: true },
  },
  { _id: false },
);

const ShoppingOrderSchema = new Schema<IShoppingOrder>(
  {
    orderId: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: [
        "pending_purchase",
        "accepted",
        "ready_for_pickup",
        "completed",
        "cancelled",
        "rejected",
      ],
      required: true,
    },
    requesterDiscordUserId: { type: String, required: true },
    requesterRegisteredCharacterName: { type: String, required: true },
    deliveryCharacterName: { type: String, required: true },
    pickup: { type: String, required: true },
    destination: { type: String, required: true },
    contractType: { type: String, enum: ["normal", "rush"], default: "normal" },
    tier: { type: String, enum: ["public", "corp"], default: "public" },
    janiceCode: { type: String, required: true },
    rawItemsText: { type: String, default: null },
    itemValue: { type: Number, required: true },
    volumeM3: { type: Number, required: true },
    items: { type: [ShoppingItemSchema], default: [] },
    haulingFee: { type: Number, required: true },
    shoppingFee: { type: Number, required: true },
    totalDue: { type: Number, required: true },
    acceptedByDiscordUserId: { type: String, default: null },
    acceptedAt: { type: Date, default: null },
    orderAlertMessageId: { type: String, default: null },
    customerDmChannelId: { type: String, default: null },
    customerStatusMessageId: { type: String, default: null },
    customerStatusUpdatesDisabledAt: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    notifiedReadyAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const ShoppingOrder = mongoose.model<IShoppingOrder>(
  "ShoppingOrder",
  ShoppingOrderSchema,
);
