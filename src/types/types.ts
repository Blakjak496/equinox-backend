export type RouteCostOption = {
  mode: "detour" | "direct";
  pricePerM3: number;
  minimum: number;
  detail: {
    mainRouteName?: string;
    extraDistanceLY?: number;
    path?: string[];
    directRoundTripLY?: number;
  };
};

export type RouteCostResult = {
  suggestChargeCollateral: boolean;
  // A single entry means direct beat every main route's best detour (or
  // there were no viable detours at all) - nothing to choose between.
  // Multiple entries means at least one detour is cheaper than direct,
  // and it's a business judgment call which route is actually applicable
  // right now, not something this calculator can decide on its own.
  options: RouteCostOption[];
};

export type EsiCorpContract = {
  acceptor_id: number;
  assignee_id: number;
  availability: "public" | "personal" | "corporation" | "alliance";
  buyout: number;
  collateral: number;
  contract_id: number;
  date_accepted: string;
  date_completed: string;
  date_expired: string;
  date_issued: string;
  days_to_complete: number;
  end_location_id: number;
  for_corporation: boolean;
  issuer_corporation_id: number;
  issuer_id: number;
  price: number;
  reward: number;
  start_location_id: number;
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
    | "reversed";
  title: string;
  type: "unknown" | "item_exchange" | "auction" | "courier" | "loan";
  volume: number;
};

export type JaniceAppraisal = {
  id: number;
  created: string;
  expires: string;
  datasetTime: string;
  code: string;
  designation: "appraisal" | "wtb" | "sell";
  pricing: "buy" | "split" | "sell" | "purchase";
  pricingVariant: "immediate" | "top5percent";
  pricePercentage: number;
  comment: string;
  isCompactized: boolean;
  input: string;
  failures: string;
  market: {
    id: number;
    name: string;
  };
  totalVolume: number;
  totalPackagedVolume: number;
  effectivePrices: {
    totalBuyPrice: number;
    totalSplitPrice: number;
    totalSellPrice: number;
  };
  immediatePrices: {
    totalBuyPrice: number;
    totalSplitPrice: number;
    totalSellPrice: number;
  };
  top5AveragePrices: {
    totalBuyPrice: number;
    totalSplitPrice: number;
    totalSellPrice: number;
  };
  items: {
    id: number;
    amount: number;
    buyOrderCount: number;
    buyVolume: number;
    sellOrderCount: number;
    sellVolume: number;
    effectivePrices: {
      buyPrice: number;
      splitPrice: number;
      sellPrice: number;
      buyPriceTotal: number;
      splitPriceTotal: number;
      sellPriceTotal: number;
      buyPrice5DayMedian: number;
      splitPrice5DayMedian: number;
      sellPrice5DayMedian: number;
      buyPrice30DayMedian: number;
      splitPrice30DayMedian: number;
      sellPrice30DayMedian: number;
    };
    immediatePrices: {
      buyPrice: number;
      splitPrice: number;
      sellPrice: number;
      buyPriceTotal: number;
      splitPriceTotal: number;
      sellPriceTotal: number;
      buyPrice5DayMedian: number;
      splitPrice5DayMedian: number;
      sellPrice5DayMedian: number;
      buyPrice30DayMedian: number;
      splitPrice30DayMedian: number;
      sellPrice30DayMedian: number;
    };
    top5AveragePrices: {
      buyPrice: number;
      splitPrice: number;
      sellPrice: number;
      buyPriceTotal: number;
      splitPriceTotal: number;
      sellPriceTotal: number;
      buyPrice5DayMedian: number;
      splitPrice5DayMedian: number;
      sellPrice5DayMedian: number;
      buyPrice30DayMedian: number;
      splitPrice30DayMedian: number;
      sellPrice30DayMedian: number;
    };
    totalVolume: number;
    totalPackagedVolume: number;
    itemType: {
      eid: number;
      name: string;
      volume: number;
      packagedVolume: number;
    };
  }[];
};
