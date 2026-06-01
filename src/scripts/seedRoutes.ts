import mongoose from "mongoose";
import dotenv from "dotenv";
import { Route, IRouteTerms, IPricingOverride } from "../models/Routes";

dotenv.config();

type RouteInput = {
  systems: [string, string];
  oneWay?: boolean;
  terms: Partial<IRouteTerms>;
  pricingOverrides?: IPricingOverride[];
};

export const routes: RouteInput[] = [
  {
    systems: ["Jita", "BKG-Q2"],
    oneWay: true,
    terms: {
      rate: 800,
      minReward: 15000000,
      collateralFeePercent: 0.5,
    },
  },
  {
    systems: ["Jita", "C-4ZOS"],
    oneWay: true,
    terms: {
      rate: 800,
      minReward: 15000000,
      collateralFeePercent: 0.5,
    },
  },
  {
    systems: ["Jita", "AH-B84"],
    oneWay: true,
    terms: {
      rate: 800,
      minReward: 15000000,
      collateralFeePercent: 0.5,
    },
  },
  {
    systems: ["Jita", "4-HWWF"],
    oneWay: true,
    terms: {
      rate: 600,
      minReward: 15000000,
      collateralFeePercent: 0.5,
    },
  },
  {
    systems: ["BKG-Q2", "BKG-Q2"],
    terms: {
      minReward: 5000000,
      maxVolume: 1200000,
    },
  },
  {
    systems: ["BKG-Q2", "4-HWWF"],
    terms: { rate: 450, minReward: 89000000 },
  },
  {
    systems: ["BKG-Q2", "W-4FA9"],
    terms: {
      minReward: 37000000,
      rushPrice: 50000000,
    },
  },
  {
    systems: ["BKG-Q2", "AH-B84"],
    terms: {
      minReward: 23000000,
      rushPrice: 50000000,
    },
  },
  {
    systems: ["BKG-Q2", "G06-8Y"],
    terms: { rate: 250, minReward: 46000000 },
  },
  {
    systems: ["BKG-Q2", "M-UC0S"],
    terms: { rate: 200, minReward: 37000000 },
  },
  {
    systems: ["BKG-Q2", "ZXA-V6"],
    terms: { rate: 150, minReward: 24000000 },
  },
  {
    systems: ["BKG-Q2", "NV-3KA"],
    terms: { rate: 150, minReward: 29000000 },
  },
  {
    systems: ["BKG-Q2", "X47L-Q"],
    terms: { rate: 650, minReward: 117000000 },
  },
  {
    systems: ["BKG-Q2", "B-9C24"],
    terms: { rate: 850, minReward: 155000000 },
  },
  {
    systems: ["BKG-Q2", "KQK1-2"],
    terms: { rate: 300, minReward: 58000000 },
  },
  {
    systems: ["BKG-Q2", "VFK-IV"],
    terms: { rate: 750, minReward: 141000000 },
  },
  {
    systems: ["BKG-Q2", "3T7-M8"],
    terms: { rate: 1000, minReward: 184000000 },
  },
  {
    systems: ["BKG-Q2", "UMI-KK"],
    terms: { rate: 500, minReward: 88000000 },
  },
  {
    systems: ["BKG-Q2", "DBT-GB"],
    terms: { rate: 300, minReward: 54000000 },
  },
  {
    systems: ["BKG-Q2", "NL6V-7"],
    terms: { rate: 250, minReward: 49000000 },
  },
  {
    systems: ["BKG-Q2", "GKP-YT"],
    terms: { rate: 300, minReward: 55000000 },
  },
  {
    systems: ["BKG-Q2", "ME-4IU"],
    terms: {
      rate: 150,
      minReward: 31000000,
      rushPrice: 50000000,
    },
  },
  {
    systems: ["4-HWWF", "AH-B84"],
    terms: { rate: 350, minReward: 60000000 },
  },
  {
    systems: ["4-HWWF", "G06-8Y"],
    terms: { rate: 900, minReward: 164000000 },
  },
  {
    systems: ["4-HWWF", "M-UC0S"],
    terms: { rate: 450, minReward: 87000000 },
  },
  {
    systems: ["4-HWWF", "ZXA-V6"],
    terms: { rate: 450, minReward: 80000000 },
  },
  {
    systems: ["4-HWWF", "X47L-Q"],
    terms: { rate: 250, minReward: 44000000 },
  },
  {
    systems: ["4-HWWF", "B-9C24"],
    terms: { rate: 350, minReward: 64000000 },
  },
  {
    systems: ["4-HWWF", "VFK-IV"],
    terms: { rate: 300, minReward: 57000000 },
  },
  {
    systems: ["4-HWWF", "3T7-M8"],
    terms: { rate: 450, minReward: 80000000 },
  },
  {
    systems: ["4-HWWF", "UMI-KK"],
    terms: { rate: 150, minReward: 31000000 },
  },
  {
    systems: ["4-HWWF", "DBT-GB"],
    terms: { rate: 150, minReward: 24000000 },
  },

  {
    systems: ["BKG-Q2", "Z-K495"],
    terms: {
      rate: 150,
      minReward: 8000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "LXWN-W"],
    terms: {
      rate: 150,
      minReward: 9000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "XM-4L0"],
    terms: {
      rate: 150,
      minReward: 9000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "8-4GQM"],
    terms: {
      rate: 150,
      minReward: 11000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "C-LP3N"],
    terms: {
      rate: 150,
      minReward: 12000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "QCWA-Z"],
    terms: {
      rate: 150,
      minReward: 12000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "LRWD-B"],
    terms: {
      rate: 150,
      minReward: 13000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "1G-MJE"],
    terms: {
      rate: 150,
      minReward: 13000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "KV-8SN"],
    terms: {
      rate: 150,
      minReward: 13000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "52G-NZ"],
    terms: {
      rate: 150,
      minReward: 14000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "T-Q2DD"],
    terms: {
      rate: 150,
      minReward: 15000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "S-B7IT"],
    terms: {
      rate: 150,
      minReward: 15000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "5LJ-MD"],
    terms: {
      rate: 150,
      minReward: 15000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "6-O5GY"],
    terms: {
      rate: 150,
      minReward: 16000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "O-JPKH"],
    terms: {
      rate: 150,
      minReward: 16000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "B8O-KJ"],
    terms: {
      rate: 150,
      minReward: 16000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "9F-7PZ"],
    terms: {
      rate: 150,
      minReward: 17000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "B-GC1T"],
    terms: {
      rate: 150,
      minReward: 18000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "I-7RIS"],
    terms: {
      rate: 150,
      minReward: 18000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "UB-UQZ"],
    terms: {
      rate: 150,
      minReward: 18000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "0P9Z-I"],
    terms: {
      rate: 150,
      minReward: 18000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "QXQ-BA"],
    terms: {
      rate: 150,
      minReward: 18000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "WO-AIJ"],
    terms: {
      rate: 150,
      minReward: 19000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "HB7R-F"],
    terms: {
      rate: 150,
      minReward: 19000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "CS-ZGD"],
    terms: {
      rate: 150,
      minReward: 19000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "A-G1FM"],
    terms: {
      rate: 150,
      minReward: 20000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "V8W-QS"],
    terms: {
      rate: 150,
      minReward: 20000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "X7R-JW"],
    terms: {
      rate: 150,
      minReward: 20000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "JRZ-B9"],
    terms: {
      rate: 150,
      minReward: 20000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "C-HCGU"],
    terms: {
      rate: 150,
      minReward: 20000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "YG-82V"],
    terms: {
      rate: 150,
      minReward: 20000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "4DTQ-K"],
    terms: {
      rate: 150,
      minReward: 21000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "XW-2XP"],
    terms: {
      rate: 150,
      minReward: 21000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "P7Z-R3"],
    terms: {
      rate: 150,
      minReward: 22000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "4-BE0M"],
    terms: {
      rate: 150,
      minReward: 22000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "OJ-A8M"],
    terms: {
      rate: 150,
      minReward: 22000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "NTV0-1"],
    terms: {
      rate: 150,
      minReward: 22000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "ZIU-EP"],
    terms: {
      rate: 150,
      minReward: 22000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "M-HU4V"],
    terms: {
      rate: 150,
      minReward: 22000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "3-N3OO"],
    terms: {
      rate: 150,
      minReward: 23000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "Q-FEEJ"],
    terms: {
      rate: 150,
      minReward: 23000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "F-9F6Q"],
    terms: {
      rate: 150,
      minReward: 23000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "2B7A-3"],
    terms: {
      rate: 150,
      minReward: 23000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "MA-VDX"],
    terms: {
      rate: 150,
      minReward: 23000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },

  {
    systems: ["BKG-Q2", "JTAU-5"],
    terms: {
      rate: 150,
      minReward: 24000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "4-48K1"],
    terms: {
      rate: 150,
      minReward: 24000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "J9-5MQ"],
    terms: {
      rate: 150,
      minReward: 24000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "X4UV-Z"],
    terms: {
      rate: 150,
      minReward: 25000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "R4O-I6"],
    terms: {
      rate: 150,
      minReward: 25000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "3F-JZF"],
    terms: {
      rate: 150,
      minReward: 26000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "EQI2-2"],
    terms: {
      rate: 150,
      minReward: 26000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "KL3O-J"],
    terms: {
      rate: 150,
      minReward: 26000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "D4R-H7"],
    terms: {
      rate: 150,
      minReward: 26000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "RO90-H"],
    terms: {
      rate: 150,
      minReward: 26000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "C-4ZOS"],
    terms: {
      rate: 150,
      minReward: 26000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "Q-4DEC"],
    terms: {
      rate: 150,
      minReward: 27000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "Q-NJZ4"],
    terms: {
      rate: 150,
      minReward: 27000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "BWI1-9"],
    terms: {
      rate: 150,
      minReward: 27000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "J7YR-1"],
    terms: {
      rate: 150,
      minReward: 27000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "313I-B"],
    terms: {
      rate: 150,
      minReward: 28000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "O94U-A"],
    terms: {
      rate: 150,
      minReward: 28000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "NEH-CS"],
    terms: {
      rate: 150,
      minReward: 28000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "C-VGYO"],
    terms: {
      rate: 150,
      minReward: 28000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "C-LBQS"],
    terms: {
      rate: 150,
      minReward: 28000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "3-TD6L"],
    terms: {
      rate: 150,
      minReward: 28000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "J52-BH"],
    terms: {
      rate: 150,
      minReward: 28000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "K-8SQS"],
    terms: {
      rate: 150,
      minReward: 28000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "CX-1XF"],
    terms: {
      rate: 150,
      minReward: 29000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "5-0WB9"],
    terms: {
      rate: 150,
      minReward: 29000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "XW-JHT"],
    terms: {
      rate: 150,
      minReward: 29000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },

  {
    systems: ["BKG-Q2", "EWN-2U"],
    terms: {
      rate: 150,
      minReward: 30000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "NLPB-0"],
    terms: {
      rate: 150,
      minReward: 30000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "PKG4-7"],
    terms: {
      rate: 150,
      minReward: 31000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "PUWL-4"],
    terms: {
      rate: 150,
      minReward: 31000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "DCI7-7"],
    terms: {
      rate: 150,
      minReward: 32000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "5-P1Y2"],
    terms: {
      rate: 150,
      minReward: 32000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "VL3I-M"],
    terms: {
      rate: 150,
      minReward: 32000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "UQ9-3C"],
    terms: {
      rate: 150,
      minReward: 33000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "1IX-C0"],
    terms: {
      rate: 150,
      minReward: 33000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "Y-1918"],
    terms: {
      rate: 150,
      minReward: 35000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "KMC-WI"],
    terms: {
      rate: 150,
      minReward: 37000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "KMQ4-V"],
    terms: {
      rate: 150,
      minReward: 37000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "KJ-QWL"],
    terms: {
      rate: 150,
      minReward: 37000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "9-B1DS"],
    terms: {
      rate: 150,
      minReward: 39000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "SVB-RE"],
    terms: {
      rate: 150,
      minReward: 39000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "CH9L-K"],
    terms: {
      rate: 150,
      minReward: 40000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },

  {
    systems: ["BKG-Q2", "I-7JR4"],
    terms: {
      rate: 150,
      minReward: 41000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "BU-IU4"],
    terms: {
      rate: 150,
      minReward: 42000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "3KNA-N"],
    terms: {
      rate: 150,
      minReward: 43000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
  {
    systems: ["BKG-Q2", "QYZM-W"],
    terms: {
      rate: 150,
      minReward: 43000000,
      rushPrice: 50000000,
    },
    pricingOverrides: [
      {
        tier: "corp",
        terms: {
          rate: 0,
        },
      },
    ],
  },
];

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  let inserted = 0;

  for (const route of routes) {
    await Route.findOneAndUpdate({ systems: route.systems }, route, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
    inserted++;
  }

  console.log(`Synced ${inserted} routes`);
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
