import { JaniceAppraisal } from "../types/types";

function buildJaniceAppraisalUrl(pricing: "buy" | "sell" | "split"): string {
  return `https://janice.e-351.com/api/rest/v2/appraisal?market=2&pricing=${pricing}&pricingVariant=immediate`;
}

function getApiKey(): string {
  const apiKey = process.env.JANICE_API_KEY;
  if (!apiKey) throw new Error("Missing JANICE_API_KEY");
  return apiKey;
}

export async function runJaniceAppraisal(
  itemsText: string,
  pricing: "buy" | "sell" | "split" = "sell",
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

export function buildJaniceUrl(code: string): string {
  return `https://janice.e-351.com/a/${code}`;
}

export function extractJaniceCode(janiceLink: string): string | null {
  const match = janiceLink.match(/\/a\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}
