import { CortexAccount } from "../models/CortexAccount";
import { CortexCharacter, ICortexCharacter } from "../models/CortexCharacter";
import { encrypt, decrypt } from "../lib/crypto";
import { CortexSsoResult, refreshCortexTokens } from "./cortexSso";
import { CortexSessionPayload } from "../lib/cortexSession";

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

export type CallbackOutcome =
  | { ok: true; session: CortexSessionPayload }
  | { ok: false; reason: "character_linked_elsewhere" };

// eve_character_id is looked up first, always - not session state - so logging back in
// with any already-linked character resolves to the same account instead of a new one
export async function handleCortexCallback(
  sso: CortexSsoResult,
  existingSession: CortexSessionPayload | null,
): Promise<CallbackOutcome> {
  let found = await CortexCharacter.findOne({ eveCharacterId: sso.characterId });

  // owner_hash changed = character was sold/transferred since we linked it; treat as new
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

  const fallback = await CortexCharacter.findOne({ accountId: session.accountId });
  if (!fallback) return { ok: true, loggedOut: true };

  return {
    ok: true,
    loggedOut: false,
    session: { accountId: session.accountId, activeCharacterId: String(fallback._id) },
  };
}

export async function deleteAccount(session: CortexSessionPayload): Promise<void> {
  await CortexCharacter.deleteMany({ accountId: session.accountId });
  await CortexAccount.findByIdAndDelete(session.accountId);
}

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
