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

// not verified - token comes straight from CCP over TLS, nothing client-supplied to protect against
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
