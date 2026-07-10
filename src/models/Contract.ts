import mongoose, { Schema, Document } from "mongoose";

export interface IEmbeddedStructure {
  structureId: number;
  name: string | null;
  systemId: number | null;
  systemName: string | null;
  typeId: number | null;
  typeName: string | null;
  access: "ok" | "forbidden";
}

export interface IContractValidation {
  level: "ok" | "warning" | "fail" | null;
  reasons: string[];
  message: string | null;
}

export interface IContract extends Document {
  contractId: number;
  type: "unknown" | "item_exchange" | "auction" | "courier" | "loan" | null;
  status:
    | "outstanding"
    | "in_progress"
    | "finished_issuer"
    | "finished_contractor"
    | "finished"
    | "cancelled"
    | "rejected"
    | "failed"
    | "deleted"
    | "reversed"
    | null;
  dateIssued: string | null;
  dateExpired: string | null;
  dateAccepted: string | null;
  dateCompleted: string | null;
  title: string | null;
  volume: number | null;
  reward: number | null;
  collateral: number | null;
  price: number | null;
  buyout: number | null;
  issuerId: number | null;
  issuerCorporationId: number | null;
  assigneeId: number | null;
  acceptorId: number | null;
  acceptedByName: string | null;
  availability: "public" | "personal" | "corporation" | "alliance" | null;
  forCorporation: boolean | null;
  daysToComplete: number | null;
  startLocationId: number | null;
  endLocationId: number | null;
  isRush: boolean;
  isOverdue: boolean;
  overduePingedAt: Date | null;
  discordMessageId: string | null;
  discordChannelType: "default" | "jita" | null;
  pickupStructure: IEmbeddedStructure | null;
  dropoffStructure: IEmbeddedStructure | null;
  validation: IContractValidation;
  buybackQuoteId: string | null;
  buybackDiscrepancy: IContractValidation | null;
}

const EmbeddedStructureSchema = new Schema<IEmbeddedStructure>(
  {
    structureId: { type: Number, required: true },
    name: { type: String, default: null },
    systemId: { type: Number, default: null },
    systemName: { type: String, default: null },
    typeId: { type: Number, default: null },
    typeName: { type: String, default: null },
    access: { type: String, enum: ["ok", "forbidden"], required: true },
  },
  { _id: false },
);

const ContractSchema = new Schema<IContract>(
  {
    contractId: { type: Number, required: true, unique: true },
    type: {
      type: String,
      enum: ["unknown", "item_exchange", "auction", "courier", "loan"],
      default: null,
    },
    status: {
      type: String,
      enum: [
        "outstanding",
        "in_progress",
        "finished_issuer",
        "finished_contractor",
        "finished",
        "cancelled",
        "rejected",
        "failed",
        "deleted",
        "reversed",
      ],
      default: null,
    },
    dateIssued: { type: String, default: null },
    dateExpired: { type: String, default: null },
    dateAccepted: { type: String, default: null },
    dateCompleted: { type: String, default: null },
    title: { type: String, default: null },
    volume: { type: Number, default: null },
    reward: { type: Number, default: null },
    collateral: { type: Number, default: null },
    price: { type: Number, default: null },
    buyout: { type: Number, default: null },
    issuerId: { type: Number, default: null },
    issuerCorporationId: { type: Number, default: null },
    assigneeId: { type: Number, default: null },
    acceptorId: { type: Number, default: null },
    acceptedByName: { type: String, default: null },
    availability: {
      type: String,
      enum: ["public", "personal", "corporation", "alliance"],
      default: null,
    },
    forCorporation: { type: Boolean, default: null },
    daysToComplete: { type: Number, default: null },
    startLocationId: { type: Number, default: null },
    endLocationId: { type: Number, default: null },
    isRush: { type: Boolean, default: false },
    isOverdue: { type: Boolean, default: false },
    overduePingedAt: { type: Date, default: null },
    discordMessageId: { type: String, default: null },
    discordChannelType: {
      type: String,
      enum: ["default", "jita"],
      default: null,
    },
    pickupStructure: { type: EmbeddedStructureSchema, default: null },
    dropoffStructure: { type: EmbeddedStructureSchema, default: null },
    validation: {
      level: { type: String, enum: ["ok", "warning", "fail"], default: null },
      reasons: { type: [String], default: [] },
      message: { type: String, default: null },
    },
    buybackQuoteId: { type: String, default: null },
    buybackDiscrepancy: {
      type: {
        level: { type: String, enum: ["ok", "warning", "fail"], default: null },
        reasons: { type: [String], default: [] },
        message: { type: String, default: null },
      },
      default: null,
    },
  },
  { timestamps: true },
);

export const Contract = mongoose.model<IContract>("Contract", ContractSchema);
