import { EsiAuth } from "../models/EsiAuth";
import { Config } from "../models/Config";
import { decrypt } from "./crypto";

type CachedToken = { token: string; expiresAt: number };

// Keyed by characterId - multiple characters can be connected at once, each
// with its own independently-cached access token and in-flight refresh.
const tokenCache = new Map<string, CachedToken>();
const refreshPromises = new Map<string, Promise<string>>();

function tokenIsValid(characterId: string): boolean {
  const cached = tokenCache.get(characterId);
  return cached !== undefined && Date.now() < cached.expiresAt - 60000;
}

// Call after writing a new refresh token to EsiAuth (a fresh SSO
// authorization, e.g. to pick up a newly-added scope). Without this, a
// still-valid cached access token from before the reconnect keeps getting
// reused - issued under the old scope set - until it naturally expires
// (up to ~20 min), silently ignoring the new refresh token in the DB.
// Omit characterId to clear every cached character's token.
export function invalidateAccessTokenCache(characterId?: string): void {
  if (characterId) {
    tokenCache.delete(characterId);
    refreshPromises.delete(characterId);
  } else {
    tokenCache.clear();
    refreshPromises.clear();
  }
}

export async function getAccessToken(characterId: string): Promise<string> {
  if (tokenIsValid(characterId)) {
    return tokenCache.get(characterId)!.token;
  }

  const inflight = refreshPromises.get(characterId);
  if (inflight) {
    return inflight;
  }

  const promise = (async () => {
    const auth = await EsiAuth.findOne({ characterId });
    if (!auth)
      throw new Error(`No ESI auth found for character ${characterId}.`);

    const decryptedRefreshToken = decrypt(auth.refreshToken);
    let accessToken: string;
    let expiresIn: number;
    try {
      ({ accessToken, expiresIn } = await refreshAccessToken(
        decryptedRefreshToken,
      ));
    } catch (err) {
      // A revoked/expired refresh token means this character needs to go
      // through SSO again - surfaced in the admin character list instead of
      // just failing whichever cron job happened to touch it next.
      if (err instanceof Error && err.message === "invalid_grant") {
        await EsiAuth.updateOne({ characterId }, { needsReconnect: true });
      }
      throw err;
    }

    tokenCache.set(characterId, {
      token: accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    refreshPromises.delete(characterId);

    return accessToken;
  })();

  refreshPromises.set(characterId, promise);
  return promise;
}

// Which connected character an automated pipeline should act as. "business"
// covers contract sync, corp asset sync, and buyback/purchase-order
// matching; "structure" covers Structure Discovery and the Jump Planner's
// structure lookups - split out because ESI's structure-visibility check is
// per-character (docking history), so a character that can't see a
// structure for one pipeline might still be fine for the other, and vice
// versa. Both fall back to whichever character happens to be connected when
// unassigned, so this is a no-op change until an admin explicitly picks a
// character for a role in Settings.
export async function resolveCharacterIdForRole(
  role: "business" | "structure",
): Promise<string> {
  const config = await Config.findOne();
  const assignedId =
    role === "business" ? config?.businessCharacterId : config?.structureCharacterId;

  if (assignedId) {
    if (await EsiAuth.exists({ characterId: assignedId })) {
      return assignedId;
    }
    // The Settings-page assignment points at a character that no longer has
    // an EsiAuth doc (removed, or the value is stale/mistyped) - falling
    // through to "whichever character is connected" is otherwise silent,
    // which is exactly what makes a wrong assignment hard to diagnose.
    console.warn(
      `[esiClient] Config.${role}CharacterId is set to "${assignedId}" but no connected character matches it - falling back to any connected character.`,
    );
  }

  const auth = await EsiAuth.findOne();
  if (!auth) throw new Error("No ESI auth found. Eve account not connected.");
  return auth.characterId;
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
