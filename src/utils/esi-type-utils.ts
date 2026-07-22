import { checkEsiLimitFromHeader } from "./general-utils";

const USER_AGENT = "EquinoxGalactic (buyback quote)";

type EsiTypeInfo = {
  volume?: number;
  packaged_volume?: number;
};

// Single-attempt, no long backoff sleep - unlike pricingRecommendation.ts's
// esiFetch (a background batch job that can afford to wait out a rate
// limit), this runs synchronously inside a live customer quote request, so
// a transient ESI hiccup should degrade gracefully rather than stall the
// response for tens of seconds.
export async function fetchTypeVolume(typeId: number): Promise<number | null> {
  const url = `https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      console.warn(`[buybackQuote] type lookup failed for typeId=${typeId}: ${res.status}`);
      return null;
    }
    checkEsiLimitFromHeader(res.headers);

    const data = (await res.json()) as EsiTypeInfo;
    return data.packaged_volume ?? data.volume ?? null;
  } catch (err) {
    console.warn(`[buybackQuote] type lookup errored for typeId=${typeId}:`, err);
    return null;
  }
}
