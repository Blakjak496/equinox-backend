import { encrypt } from "../lib/crypto";
import { EsiAuth } from "../models/EsiAuth";
import { invalidateAccessTokenCache } from "../lib/esiClient";

function decodeJwtPayload(token: string): any {
  const [, payload] = token.split(".");
  const padded =
    payload.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((payload.length + 3) % 4);
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json);
}

export async function exchangeEveCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<{
  ok: boolean;
  characterId: string;
  characterName: string | null;
  corporationId: string;
}> {
  const clientId = process.env.EVE_CLIENT_ID;
  const clientSecret = process.env.EVE_CLIENT_SECRET;

  if (!clientId || !clientSecret)
    throw new Error("Missing EVE_CLIENT_ID or EVE_CLIENT_SECRET");

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("code_verifier", codeVerifier);
  body.set("redirect_uri", redirectUri);

  const res = await fetch("https://login.eveonline.com/v2/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await res.text();
  if (!res.ok)
    throw new Error(`EVE token exchange failed ${res.status}: ${text}`);

  const token = JSON.parse(text) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const payload = decodeJwtPayload(token.access_token);

  const characterId =
    payload.sub?.match(/\d+/)?.[0] ??
    payload.character_id ??
    payload.CharacterID ??
    null;

  if (!characterId)
    throw new Error("Could not determine characterId from access token");

  const charRes = await fetch(
    `https://esi.evetech.net/latest/characters/${characterId}/?datasource=tranquility`,
    { headers: { Authorization: `Bearer ${token.access_token}` } },
  );
  const charText = await charRes.text();
  if (!charRes.ok)
    throw new Error(
      `Failed to fetch character info ${charRes.status}: ${charText}`,
    );

  const charJson = JSON.parse(charText) as {
    corporation_id: number;
    name: string;
  };
  const corporationId = String(charJson.corporation_id);
  const characterName = charJson.name ?? null;

  const encryptedRefreshToken = encrypt(token.refresh_token);

  // Keyed by characterId, not an empty filter - connecting a second (or
  // third) character now adds a new EsiAuth doc instead of overwriting
  // whichever one previously existed.
  await EsiAuth.findOneAndUpdate(
    { characterId: String(characterId) },
    {
      refreshToken: encryptedRefreshToken,
      characterName,
      corporationId,
      connectedAt: new Date(),
      needsReconnect: false,
      jwtPayload: payload,
    },
    { upsert: true, new: true },
  );

  // The new refresh token is useless to callers still holding a cached
  // access token issued under the old scope set - force the next
  // getAccessToken() to actually exchange it. Scoped to this character only
  // - other connected characters' cached tokens are unaffected.
  invalidateAccessTokenCache(String(characterId));

  return { ok: true, characterId: String(characterId), characterName, corporationId };
}
