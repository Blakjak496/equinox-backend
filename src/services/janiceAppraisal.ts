import { JaniceAppraisal } from "../types/types";

function buildJaniceAppraisalUrl(pricing: "buy" | "sell"): string {
  return `https://janice.e-351.com/api/rest/v2/appraisal?market=2&pricing=${pricing}&pricingVariant=immediate`;
}

function getApiKey(): string {
  const apiKey = process.env.JANICE_API_KEY;
  if (!apiKey) throw new Error("Missing JANICE_API_KEY");
  return apiKey;
}

export async function runJaniceAppraisal(
  itemsText: string,
  pricing: "buy" | "sell" = "sell",
): Promise<JaniceAppraisal> {
  const trimmed = itemsText.trim();
  if (!trimmed) throw new Error("itemsText is required");

  const res = await fetch(buildJaniceAppraisalUrl(pricing), {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "X-ApiKey": getApiKey(),
    },
    body: trimmed,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Janice failed (${res.status}): ${text}`);

  return JSON.parse(text);
}

export async function getJaniceAppraisalByCode(
  code: string,
): Promise<JaniceAppraisal> {
  const trimmed = code.trim();
  if (!trimmed) throw new Error("code is required");

  const url = `https://janice.e-351.com/api/rest/v2/appraisal/${encodeURIComponent(trimmed)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-ApiKey": getApiKey(),
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Janice lookup failed (${res.status}): ${text}`);

  return JSON.parse(text);
}

const ISOTOPE_PRICE_CACHE_MS = 12 * 60 * 60 * 1000; // 12 hours

let cachedIsotopePrice: number | null = null;
let isotopePriceCachedAt = 0;

export async function getNitrogenIsotopePrice(): Promise<number> {
  if (
    cachedIsotopePrice !== null &&
    Date.now() - isotopePriceCachedAt < ISOTOPE_PRICE_CACHE_MS
  ) {
    return cachedIsotopePrice;
  }

  const appraisal = await runJaniceAppraisal("Nitrogen Isotopes 1", "sell");
  const item = appraisal.items[0];
  if (!item) throw new Error("Failed to resolve Nitrogen Isotopes price");

  cachedIsotopePrice = item.immediatePrices.sellPrice;
  isotopePriceCachedAt = Date.now();
  return cachedIsotopePrice;
}

export function buildJaniceUrl(code: string): string {
  return `https://janice.e-351.com/a/${code}`;
}

export function extractJaniceCode(janiceLink: string): string | null {
  const match = janiceLink.match(/\/a\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}
