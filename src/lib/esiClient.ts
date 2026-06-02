import { EsiAuth } from "../models/EsiAuth";
import { decrypt } from "./crypto";

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;
let refreshPromise: Promise<string> | null = null;

function tokenIsValid(): boolean {
  return cachedToken !== null && Date.now() < tokenExpiresAt - 60000;
}

export async function getAccessToken(): Promise<string> {
  if (tokenIsValid()) {
    return cachedToken!;
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const auth = await EsiAuth.findOne();
    if (!auth) throw new Error("No ESI auth found. Eve account not connected.");

    const decryptedRefreshToken = decrypt(auth.refreshToken);
    const { accessToken, expiresIn } = await refreshAccessToken(
      decryptedRefreshToken,
    );

    cachedToken = accessToken;
    tokenExpiresAt = Date.now() + expiresIn * 1000;
    refreshPromise = null;

    return cachedToken;
  })();

  return refreshPromise;
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const EVE_CLIENT_ID = process.env.EVE_CLIENT_ID;
  const EVE_CLIENT_SECRET = process.env.EVE_CLIENT_SECRET;

  if (!EVE_CLIENT_ID || !EVE_CLIENT_SECRET) {
    throw new Error("EVE_CLIENT_ID or EVE_CLIENT_SECRET not set");
  }

  const creds = Buffer.from(`${EVE_CLIENT_ID}:${EVE_CLIENT_SECRET}`).toString(
    "base64",
  );

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);

  const res = await fetch("https://login.eveonline.com/v2/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    if (text.includes("invalid_grant")) throw new Error("invalid_grant");
    throw new Error(`Token refresh failed ${res.status}: ${text}`);
  }

  const json = JSON.parse(text) as { access_token: string; expires_in: number };
  return { accessToken: json.access_token, expiresIn: json.expires_in };
}

export async function esiGet<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "EquinoxGalactic (contracts sync)",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ESI GET failed ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}
