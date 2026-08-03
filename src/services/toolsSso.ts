// EVE SSO exchange for the Tools app's own SSO application (separate
// client id/secret from the admin app's - this one only ever requests the
// publicData scope). Unlike exchangeEveCode.ts (which is for connecting
// long-lived *service* characters and stores their refresh token in
// EsiAuth), the refresh token here is handed back to the caller to store
// against a ToolsSession, not persisted by this module.

function decodeJwtPayload(token: string): any {
  const [, payload] = token.split(".");
  const padded =
    payload.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((payload.length + 3) % 4);
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json);
}

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.TOOLS_EVE_CLIENT_ID;
  const clientSecret = process.env.TOOLS_EVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing TOOLS_EVE_CLIENT_ID or TOOLS_EVE_CLIENT_SECRET");
  }
  return { clientId, clientSecret };
}

async function requestToken(body: URLSearchParams): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const { clientId, clientSecret } = getCredentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://login.eveonline.com/v2/oauth/token", {
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

async function fetchCharacter(
  characterId: string,
  accessToken: string,
): Promise<{ corporationId: string; characterName: string | null }> {
  const res = await fetch(
    `https://esi.evetech.net/latest/characters/${characterId}/?datasource=tranquility`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Failed to fetch character info ${res.status}: ${text}`);
  }

  const json = JSON.parse(text) as { corporation_id: number; name: string };
  return { corporationId: String(json.corporation_id), characterName: json.name ?? null };
}

function characterIdFromAccessToken(accessToken: string): string {
  const payload = decodeJwtPayload(accessToken);
  const characterId =
    payload.sub?.match(/\d+/)?.[0] ?? payload.character_id ?? payload.CharacterID ?? null;
  if (!characterId) throw new Error("Could not determine characterId from access token");
  return String(characterId);
}

export type ToolsSsoResult = {
  characterId: string;
  characterName: string | null;
  corporationId: string;
  eveAccessToken: string;
  eveRefreshToken: string;
};

export async function exchangeToolsCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<ToolsSsoResult> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("code_verifier", codeVerifier);
  body.set("redirect_uri", redirectUri);

  const { accessToken, refreshToken } = await requestToken(body);
  const characterId = characterIdFromAccessToken(accessToken);
  const { corporationId, characterName } = await fetchCharacter(characterId, accessToken);

  return {
    characterId,
    characterName,
    corporationId,
    eveAccessToken: accessToken,
    eveRefreshToken: refreshToken,
  };
}

// Re-exchanges a stored EVE refresh token for a fresh access token, live
// character/corp info, and (per CCP's own rotation) a brand new refresh
// token - the caller is responsible for persisting the new one in place of
// the old.
export async function refreshEveSession(eveRefreshToken: string): Promise<ToolsSsoResult> {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", eveRefreshToken);

  const { accessToken, refreshToken } = await requestToken(body);
  const characterId = characterIdFromAccessToken(accessToken);
  const { corporationId, characterName } = await fetchCharacter(characterId, accessToken);

  return {
    characterId,
    characterName,
    corporationId,
    eveAccessToken: accessToken,
    eveRefreshToken: refreshToken,
  };
}
