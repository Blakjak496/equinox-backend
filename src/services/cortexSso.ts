import crypto from "crypto";
import {
  requestEveToken,
  decodeEveJwtPayload,
  fetchEveCharacterInfo,
  EveCredentials,
} from "../lib/eveSsoClient";

// EVE Cortex's own SSO application (CORTEX_EVE_CLIENT_ID/SECRET) - separate
// dev portal app from both the admin app (EVE_CLIENT_ID) and the Tools
// app (TOOLS_EVE_CLIENT_ID), since Cortex requests a much larger scope set
// than either. Server-driven PKCE authorization-code flow: unlike
// toolsSso.ts (which receives an already-obtained code+codeVerifier from a
// client that ran the PKCE dance itself), this module owns the redirect to
// EVE and back, since Cortex's session is a cookie the backend sets on the
// callback response, not a token handed to a client to manage.

const AUTHORIZE_URL = "https://login.eveonline.com/v2/oauth/authorize";

const SCOPES = [
  "publicData",
  "esi-calendar.respond_calendar_events.v1",
  "esi-calendar.read_calendar_events.v1",
  "esi-location.read_location.v1",
  "esi-location.read_ship_type.v1",
  "esi-mail.organize_mail.v1",
  "esi-mail.read_mail.v1",
  "esi-mail.send_mail.v1",
  "esi-skills.read_skills.v1",
  "esi-skills.read_skillqueue.v1",
  "esi-wallet.read_character_wallet.v1",
  "esi-search.search_structures.v1",
  "esi-clones.read_clones.v1",
  "esi-characters.read_contacts.v1",
  "esi-universe.read_structures.v1",
  "esi-killmails.read_killmails.v1",
  "esi-assets.read_assets.v1",
  "esi-planets.manage_planets.v1",
  "esi-ui.open_window.v1",
  "esi-ui.write_waypoint.v1",
  "esi-characters.write_contacts.v1",
  "esi-fittings.read_fittings.v1",
  "esi-fittings.write_fittings.v1",
  "esi-markets.structure_markets.v1",
  "esi-characters.read_loyalty.v1",
  "esi-characters.read_chat_channels.v1",
  "esi-characters.read_medals.v1",
  "esi-characters.read_standings.v1",
  "esi-characters.read_agents_research.v1",
  "esi-industry.read_character_jobs.v1",
  "esi-markets.read_character_orders.v1",
  "esi-characters.read_blueprints.v1",
  "esi-characters.read_corporation_roles.v1",
  "esi-location.read_online.v1",
  "esi-contracts.read_character_contracts.v1",
  "esi-clones.read_implants.v1",
  "esi-characters.read_fatigue.v1",
  "esi-characters.read_notifications.v1",
  "esi-industry.read_character_mining.v1",
  "esi-planets.read_customs_offices.v1",
  "esi-characters.read_titles.v1",
  "esi-characters.read_fw_stats.v1",
  "esi-characters.read_freelance_jobs.v1",
  "esi-structures.read_corporation.v1",
  "esi-structures.read_character.v1",
  "esi-activities.read_character.v1",
  "esi-access.read_lists.v1",
  "esi.activity.char:read",
  "esi.cosmetic.char:read",
].join(" ");

function getCredentials(): EveCredentials & { callbackUrl: string } {
  const clientId = process.env.CORTEX_EVE_CLIENT_ID;
  const clientSecret = process.env.CORTEX_EVE_CLIENT_SECRET;
  const callbackUrl = process.env.CORTEX_EVE_CALLBACK_URL;
  if (!clientId || !clientSecret || !callbackUrl) {
    throw new Error(
      "Missing CORTEX_EVE_CLIENT_ID, CORTEX_EVE_CLIENT_SECRET, or CORTEX_EVE_CALLBACK_URL",
    );
  }
  return { clientId, clientSecret, callbackUrl };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export type PkceChallenge = { verifier: string; challenge: string };

export function generatePkceChallenge(): PkceChallenge {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// prompt=login forces CCP's account-chooser screen instead of silently
// reusing whichever character this browser last authenticated as - without
// it, "Add a different character" is confusing (see the brief's CCP SSO
// note): the user picks "add character" but lands back on the same one.
export function buildAuthorizeUrl(state: string, pkce: PkceChallenge): string {
  const { clientId, callbackUrl } = getCredentials();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "login");
  return url.toString();
}

function parseAccessTokenClaims(accessToken: string): {
  characterId: number;
  characterName: string;
  ownerHash: string;
  scopes: string[];
} {
  const claims = decodeEveJwtPayload(accessToken);

  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const characterId = Number(sub.match(/\d+/)?.[0]);
  if (!characterId) throw new Error("Could not determine character id from access token");

  const characterName = typeof claims.name === "string" ? claims.name : "";
  const ownerHash = typeof claims.owner === "string" ? claims.owner : "";
  if (!ownerHash) throw new Error("Access token is missing the owner claim");

  const scp = claims.scp;
  const scopes = Array.isArray(scp)
    ? scp.filter((s): s is string => typeof s === "string")
    : typeof scp === "string"
      ? [scp]
      : [];

  return { characterId, characterName, ownerHash, scopes };
}

export type CortexSsoResult = {
  characterId: number;
  characterName: string;
  ownerHash: string;
  scopes: string[];
  corporationId: number;
  allianceId: number | null;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

async function resolveFromToken(token: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}): Promise<CortexSsoResult> {
  const { characterId, ownerHash, scopes } = parseAccessTokenClaims(token.accessToken);
  // The JWT's own `name` claim can be stale after a character rename -
  // ESI's character info is the live value, so that's used for the name
  // too rather than trusting the token's copy.
  const { corporationId, allianceId, characterName } = await fetchEveCharacterInfo(
    characterId,
    token.accessToken,
  );

  return {
    characterId,
    characterName,
    ownerHash,
    scopes,
    corporationId,
    allianceId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresIn: token.expiresIn,
  };
}

export async function exchangeCortexCode(
  code: string,
  codeVerifier: string,
): Promise<CortexSsoResult> {
  const { callbackUrl, ...credentials } = getCredentials();
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("code_verifier", codeVerifier);
  body.set("redirect_uri", callbackUrl);

  const token = await requestEveToken(credentials, body);
  return resolveFromToken(token);
}

// Re-exchanges a stored refresh token. Per CCP's rotation, always returns a
// brand new refresh token - the caller must persist it in place of the old
// one (see services/cortexAuth.ts's refreshCharacterTokens).
export async function refreshCortexTokens(refreshToken: string): Promise<CortexSsoResult> {
  const { callbackUrl: _callbackUrl, ...credentials } = getCredentials();
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);

  const token = await requestEveToken(credentials, body);
  return resolveFromToken(token);
}
