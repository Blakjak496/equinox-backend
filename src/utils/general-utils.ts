import { getConfig } from "../lib/config";
import { IContractValidation } from "../models/Contract";
import { IRouteTerms, Route } from "../models/Routes";

export async function fetchJsonWithBearer<T>(
  url: string,
  accessToken: string,
  userAgent: string,
): Promise<{
  status: number;
  ok: boolean;
  text: string;
  json: T | null;
  headers: Headers;
}> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": userAgent,
    },
  });

  const text = await res.text();
  const json = text ? (JSON.parse(text) as T) : null;

  return {
    status: res.status,
    ok: res.ok,
    text,
    json,
    headers: res.headers,
  };
}

export async function fetchJson<T>(
  url: string,
  userAgent: string,
): Promise<{
  status: number;
  ok: boolean;
  text: string;
  json: T | null;
  headers: Headers;
}> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": userAgent,
    },
  });

  const text = await res.text();
  const json = text ? (JSON.parse(text) as T) : null;

  return { status: res.status, ok: res.ok, text, json, headers: res.headers };
}

export function getEsiLimitInfo(headers: Headers) {
  return {
    remain: parseHeaderNumber(headers.get("x-esi-error-limit-remain")),
    reset: parseHeaderNumber(headers.get("x-esi-error-limit-reset")),
  };
}

function parseHeaderNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function checkEsiLimitFromHeader(headers: Headers): void {
  const esiLimit = getEsiLimitInfo(headers);
  if (
    esiLimit.remain !== null &&
    esiLimit.reset !== null &&
    esiLimit.remain <= 10
  ) {
    throw new Error(
      `Skipping structure enrichment, ESI error budget low: remain=${esiLimit.remain} reset=${esiLimit.reset}`,
    );
  }
}

export async function validateContract(
  systems: [string, string],
  volume: number,
  collateral: number,
  reward: number,
): Promise<IContractValidation> {
  const config = getConfig();
  const route = await Route.findOne({ systems });
  if (!route)
    return {
      level: "fail",
      reasons: ["Invalid route"],
      message: "Failed validation",
    };

  //fail conditions
  const withinVolumeLimit = volume <= route.terms.maxVolume;
  const withinCollateralLimit = collateral <= config.maxCollateral;
  const routeIsValid = Route.exists({ systems });

  //warning conditions
  const correctReward =
    volume * route.terms.rate +
      collateral * route.terms.collateralFeePercent ===
    reward;

  const reasons = [];

  const fail = !withinVolumeLimit || !withinCollateralLimit || !routeIsValid;
  !withinVolumeLimit && reasons.push("Exceeds volume limit.");
  !withinCollateralLimit && reasons.push("Exceeds collateral limit.");
  !routeIsValid && reasons.push("Invalid route.");

  const warning = !correctReward;
  !correctReward && reasons.push("Reward does not match contract terms.");

  return {
    level: fail ? "fail" : warning ? "warning" : "ok",
    reasons,
    message: fail
      ? "Failed validation"
      : warning
        ? "Requires check"
        : "Passed validation",
  };
}
