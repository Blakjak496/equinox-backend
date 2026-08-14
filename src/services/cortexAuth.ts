import { CortexAccount } from "../models/CortexAccount";
import { CortexCharacter, ICortexCharacter } from "../models/CortexCharacter";
import { encrypt, decrypt } from "../lib/crypto";
import { CortexSsoResult, refreshCortexTokens } from "./cortexSso";
import { CortexSessionPayload } from "../lib/cortexSession";

// Proactively refresh anything expiring within this window, rather than
// waiting for ESI to actually reject an expired token (see the brief's
// "Token refresh" section).
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function toTokenFields(sso: CortexSsoResult) {
  return {
    eveCharacterName: sso.characterName,
    ownerHash: sso.ownerHash,
    corporationId: sso.corporationId,
    allianceId: sso.allianceId,
    accessTokenEncrypted: encrypt(sso.accessToken),
    refreshTokenEncrypted: encrypt(sso.refreshToken),
    tokenExpiresAt: new Date(Date.now() + sso.expiresIn * 1000),
    scopes: sso.scopes,
    needsRelink: false,
  };
}

// --- SSO callback --------------------------------------------------------
// The one rule everything below follows (per the brief): the deciding
// factor is never "is there a session", it's "does a Character row already
// exist for this eve_character_id" - checked first, before session state.
// That's what makes logging back in with any already-linked character
// resolve to the same Account instead of minting a new one.

export type CallbackOutcome =
  | { ok: true; session: CortexSessionPayload }
  | { ok: false; reason: "character_linked_elsewhere" };

export async function handleCortexCallback(
  sso: CortexSsoResult,
  existingSession: CortexSessionPayload | null,
): Promise<CallbackOutcome> {
  let found = await CortexCharacter.findOne({ eveCharacterId: sso.characterId });

  // owner_hash changed since we last linked this character id - CCP's
  // owner of it has changed (sold/transferred). The old link no longer
  // represents anyone's access; whoever is authenticating right now (with
  // a token CCP just issued, proving *current* ownership) is treated
  // exactly as if this were a brand new character to link.
  if (found && found.ownerHash !== sso.ownerHash) {
    console.warn(
      `[cortexAuth] owner hash changed for character ${sso.characterId} - discarding stale link (was account ${found.accountId})`,
    );
    await found.deleteOne();
    found = null;
  }

  if (found) {
    if (existingSession && String(found.accountId) !== existingSession.accountId) {
      return { ok: false, reason: "character_linked_elsewhere" };
    }

    Object.assign(found, toTokenFields(sso));
    found.lastSyncedAt = new Date();
    await found.save();

    const accountId = String(found.accountId);
    // A session already active for this same account (re-login, or an
    // "add character" callback for a character already linked) keeps
    // whatever was active - only a fresh session initializes active to the
    // character just used to log in.
    const activeCharacterId = existingSession
      ? existingSession.activeCharacterId
      : String(found._id);

    return { ok: true, session: { accountId, activeCharacterId } };
  }

  const accountId = existingSession
    ? existingSession.accountId
    : String((await CortexAccount.create({}))._id);

  const created = await CortexCharacter.create({
    accountId,
    eveCharacterId: sso.characterId,
    linkedAt: new Date(),
    lastSyncedAt: new Date(),
    ...toTokenFields(sso),
  });

  const activeCharacterId = existingSession
    ? existingSession.activeCharacterId
    : String(created._id);

  return { ok: true, session: { accountId, activeCharacterId } };
}

// --- Unlink ----------------------------------------------------------

export type UnlinkOutcome =
  | { ok: true; loggedOut: false; session: CortexSessionPayload }
  | { ok: true; loggedOut: true }
  | { ok: false; reason: "not_found" | "forbidden" };

export async function unlinkCharacter(
  session: CortexSessionPayload,
  characterId: string,
): Promise<UnlinkOutcome> {
  const character = await CortexCharacter.findById(characterId);
  if (!character) return { ok: false, reason: "not_found" };
  if (String(character.accountId) !== session.accountId) return { ok: false, reason: "forbidden" };

  await character.deleteOne();

  if (session.activeCharacterId !== characterId) {
    return { ok: true, loggedOut: false, session };
  }

  // Unlinked the active character - fall back to another linked one for
  // this session. If that was the last character on the account, there's
  // nothing meaningful left to be "logged in" as, so log out entirely
  // rather than carry a session with no active character.
  const fallback = await CortexCharacter.findOne({ accountId: session.accountId });
  if (!fallback) return { ok: true, loggedOut: true };

  return {
    ok: true,
    loggedOut: false,
    session: { accountId: session.accountId, activeCharacterId: String(fallback._id) },
  };
}

// --- Delete account ------------------------------------------------
// Removes every linked character (and their stored tokens) along with the
// Account itself, in one go - not a loop of individual unlinks, since
// those each do fallback-active-character bookkeeping that's pointless
// when the whole account is going away.

export async function deleteAccount(session: CortexSessionPayload): Promise<void> {
  await CortexCharacter.deleteMany({ accountId: session.accountId });
  await CortexAccount.findByIdAndDelete(session.accountId);
}

// --- Switch active character -----------------------------------------

export type SwitchOutcome =
  | { ok: true; session: CortexSessionPayload }
  | { ok: false; reason: "not_found" | "forbidden" };

export async function switchActiveCharacter(
  session: CortexSessionPayload,
  characterId: string,
): Promise<SwitchOutcome> {
  const character = await CortexCharacter.findById(characterId);
  if (!character) return { ok: false, reason: "not_found" };
  if (String(character.accountId) !== session.accountId) return { ok: false, reason: "forbidden" };

  return { ok: true, session: { accountId: session.accountId, activeCharacterId: characterId } };
}

// --- Reading characters (never exposes tokens) ------------------------

export type PublicCortexCharacter = {
  id: string;
  eveCharacterId: number;
  eveCharacterName: string;
  corporationId: number;
  allianceId: number | null;
  scopes: string[];
  needsRelink: boolean;
  linkedAt: Date;
};

function toPublic(character: ICortexCharacter): PublicCortexCharacter {
  return {
    id: String(character._id),
    eveCharacterId: character.eveCharacterId,
    eveCharacterName: character.eveCharacterName,
    corporationId: character.corporationId,
    allianceId: character.allianceId,
    scopes: character.scopes,
    needsRelink: character.needsRelink,
    linkedAt: character.linkedAt,
  };
}

export async function getAccountCharacters(accountId: string): Promise<PublicCortexCharacter[]> {
  const characters = await CortexCharacter.find({ accountId }).sort({ linkedAt: 1 });
  return characters.map(toPublic);
}

// --- Token refresh -----------------------------------------------------
// Shared by the proactive background job (refreshDueCharacters) and any
// tool route that needs a guaranteed-fresh access token on demand
// (getValidAccessToken) - both funnel through the same owner-hash check
// and needsRelink flagging so there's exactly one place that logic lives.

async function refreshCharacterTokens(character: ICortexCharacter): Promise<void> {
  let fresh: CortexSsoResult;
  try {
    fresh = await refreshCortexTokens(decrypt(character.refreshTokenEncrypted));
  } catch (err) {
    console.error(
      `[cortexAuth] token refresh failed for character ${character.eveCharacterId}:`,
      err,
    );
    character.needsRelink = true;
    await character.save();
    return;
  }

  if (character.ownerHash !== fresh.ownerHash) {
    console.warn(
      `[cortexAuth] owner hash changed for character ${character.eveCharacterId} during background refresh - unlinking`,
    );
    await character.deleteOne();
    return;
  }

  Object.assign(character, toTokenFields(fresh));
  character.lastSyncedAt = new Date();
  await character.save();
}

// On-demand access token for a per-character tool route. Refreshes first
// if the cached token is due, so callers never have to think about
// expiry themselves - no separate background job needed for this.
export async function getValidAccessToken(characterId: string): Promise<string> {
  const character = await CortexCharacter.findById(characterId);
  if (!character) throw new Error("Character not found");
  if (character.needsRelink) throw new Error("Character needs to be re-linked");

  if (character.tokenExpiresAt.getTime() - Date.now() <= REFRESH_MARGIN_MS) {
    await refreshCharacterTokens(character);
    if (character.needsRelink) throw new Error("Character needs to be re-linked");
  }

  return decrypt(character.accessTokenEncrypted);
}
