import { fetchJson } from "../utils/general-utils";
import { AdjustedPrice } from "../models/AdjustedPrice";

// The basis for Estimated Item Value (EIV) / industry job installation
// cost (see buildResolver.ts) - a universe-wide, CCP-published "adjusted
// price" per type, deliberately excluding regional spikes/manipulation.
// One call returns every priced type at once (confirmed live - no region
// param, no pagination), and ESI only refreshes this once every 24h, so a
// daily cron refresh (see index.ts) is all that's ever useful - the
// resolver only ever reads the cached collection, never fetches this live.
const ESI_URL = "https://esi.evetech.net/latest/markets/prices/?datasource=tranquility";

type EsiAdjustedPrice = {
  type_id: number;
  adjusted_price?: number;
  average_price?: number;
};

export async function refreshAdjustedPrices(): Promise<void> {
  const res = await fetchJson<EsiAdjustedPrice[]>(
    ESI_URL,
    "EquinoxGalactic Tools (adjusted price refresh)",
  );

  if (!res.ok || !res.json) {
    throw new Error(`Failed to fetch ESI adjusted prices: ${res.status}`);
  }

  const ops = res.json
    .filter((row) => row.adjusted_price != null)
    .map((row) => ({
      updateOne: {
        filter: { typeId: row.type_id },
        update: {
          $set: {
            typeId: row.type_id,
            adjustedPrice: row.adjusted_price,
            averagePrice: row.average_price ?? 0,
          },
        },
        upsert: true,
      },
    }));

  if (ops.length > 0) {
    await AdjustedPrice.bulkWrite(ops);
  }

  console.log(`[adjustedPrices] refreshed ${ops.length} type adjusted prices`);
}

export async function getAdjustedPrices(
  typeIds: number[],
): Promise<Map<number, number>> {
  const docs = await AdjustedPrice.find({ typeId: { $in: typeIds } })
    .select("typeId adjustedPrice")
    .lean();
  return new Map(docs.map((doc) => [doc.typeId, doc.adjustedPrice]));
}
