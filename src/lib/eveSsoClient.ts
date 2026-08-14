// Generic CCP SSO plumbing - the raw token-endpoint call and JWT decoding
// are identical across every app registered in the dev portal; only the
// credentials and which claims a caller reads back out differ. Extracted
// here because that mechanic was duplicated across exchangeEveCode.ts
// (admin app), toolsSso.ts (Tools app), and esiClient.ts (background
// service-character refresh) even before cortexSso.ts existed - a fourth
// near-identical copy wasn't worth adding.
//
// Not touching those three existing call sites to use this - they belong
// to other live apps sharing this backend and weren't part of this change.

const TOKEN_URL = "https://login.eveonline.com/v2/oauth/token";

export type EveCredentials = { clientId: string; clientSecret: string };

export type EveTokenResult = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export async function requestEveToken(
  credentials: EveCredentials,
  body: URLSearchParams,
): Promise<EveTokenResult> {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
    "base64",
  );

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`EVE token request failed ${res.status}: ${text}`);

  const token = JSON.parse(text) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn: token.expires_in,
  };
}

// No signature verification - every caller gets this token straight from
// CCP's token endpoint over TLS, not from anything client-supplied, so
// there's nothing an unverified signature would be protecting against here.
export function decodeEveJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  const padded =
    payload.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((payload.length + 3) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

export type EveCharacterInfo = {
  corporationId: number;
  allianceId: number | null;
  characterName: string;
};

export async function fetchEveCharacterInfo(
  characterId: number,
  accessToken: string,
): Promise<EveCharacterInfo> {
  const res = await fetch(
    `https://esi.evetech.net/latest/characters/${characterId}/?datasource=tranquility`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Failed to fetch character info ${res.status}: ${text}`);

  const json = JSON.parse(text) as {
    corporation_id: number;
    alliance_id?: number;
    name: string;
  };

  return {
    corporationId: json.corporation_id,
    allianceId: json.alliance_id ?? null,
    characterName: json.name,
  };
}
