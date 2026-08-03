import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { ToolsSession } from "../models/ToolsSession";
import { ToolsUser } from "../models/ToolsUser";
import { Config } from "../models/Config";
import { encrypt, decrypt } from "./crypto";
import { refreshEveSession, ToolsSsoResult } from "../services/toolsSso";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
// The actual bound on "how long can a session stay alive" - CCP's own
// refresh-token rotation never expires anything on its own as long as it
// keeps getting used, so this is what forces a real re-login periodically.
const SESSION_CEILING_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getJwtSecret(): string {
  const secret = process.env.TOOLS_JWT_SECRET;
  if (!secret) throw new Error("TOOLS_JWT_SECRET environment variable is not set");
  return secret;
}

export type ToolsAccessTokenPayload = {
  characterId: string;
  characterName: string | null;
  corporationId: string;
};

// Hand-rolled HMAC-SHA256 JWT-shaped token - avoids pulling in a JWT
// dependency for a short-lived, single-purpose access token. Consistent
// with exchangeEveCode.ts already hand-decoding EVE's own JWT elsewhere in
// this codebase.
export function signAccessToken(
  payload: ToolsAccessTokenPayload,
): { token: string; expiresIn: number } {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ACCESS_TOKEN_TTL_SECONDS };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedBody = Buffer.from(JSON.stringify(body)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", getJwtSecret())
    .update(`${encodedHeader}.${encodedBody}`)
    .digest("base64url");

  return {
    token: `${encodedHeader}.${encodedBody}.${signature}`,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

export function verifyAccessToken(token: string): ToolsAccessTokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedBody, signature] = parts;

    const expectedSignature = crypto
      .createHmac("sha256", getJwtSecret())
      .update(`${encodedHeader}.${encodedBody}`)
      .digest("base64url");

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    if (
      sigBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return null;
    }

    const body = JSON.parse(Buffer.from(encodedBody, "base64url").toString("utf8"));
    if (typeof body.exp !== "number" || body.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return {
      characterId: body.characterId,
      characterName: body.characterName ?? null,
      corporationId: body.corporationId,
    };
  } catch {
    return null;
  }
}

export interface ToolsAuthedRequest extends Request {
  toolsUser?: ToolsAccessTokenPayload;
}

export function requireToolsAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ ok: false, message: "Missing bearer token" });
    return;
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({ ok: false, message: "Invalid or expired access token" });
    return;
  }

  (req as ToolsAuthedRequest).toolsUser = payload;
  next();
}

export async function isCorpAllowed(corporationId: string): Promise<boolean> {
  const config = await Config.findOne().select("allowedCorpIds");
  return config?.allowedCorpIds?.includes(corporationId) ?? false;
}

function generateRefreshHandle(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function hashHandle(handle: string): string {
  return crypto.createHash("sha256").update(handle).digest("hex");
}

type IssuedSession = {
  refreshHandle: string;
  accessToken: string;
  expiresIn: number;
  character: ToolsAccessTokenPayload;
};

function toPayload(sso: ToolsSsoResult): ToolsAccessTokenPayload {
  return {
    characterId: sso.characterId,
    characterName: sso.characterName,
    corporationId: sso.corporationId,
  };
}

// Starts a brand new session family - called only from POST /login, after
// the corp allow-list check has already passed.
export async function createSessionFamily(sso: ToolsSsoResult): Promise<IssuedSession> {
  await ToolsUser.findOneAndUpdate(
    { characterId: sso.characterId },
    {
      characterId: sso.characterId,
      characterName: sso.characterName,
      corporationId: sso.corporationId,
      lastLoginAt: new Date(),
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  const familyId = crypto.randomUUID();
  const refreshHandle = generateRefreshHandle();

  await ToolsSession.create({
    familyId,
    characterId: sso.characterId,
    refreshHandleHash: hashHandle(refreshHandle),
    eveRefreshTokenEncrypted: encrypt(sso.eveRefreshToken),
    sessionStartedAt: new Date(),
    revoked: false,
  });

  const { token, expiresIn } = signAccessToken(toPayload(sso));

  return { refreshHandle, accessToken: token, expiresIn, character: toPayload(sso) };
}

export type RotateFailureReason = "invalid" | "reused" | "expired" | "corp_not_allowed";

export type RotateResult =
  | ({ ok: true } & IssuedSession)
  | { ok: false; reason: RotateFailureReason; message: string };

async function revokeFamily(familyId: string): Promise<void> {
  await ToolsSession.updateMany({ familyId }, { revoked: true });
}

// Re-exchanges the stored EVE refresh token (rotating it, per CCP's own
// behavior), re-checks the corp allow-list against a live ESI lookup, and
// - if everything still checks out - rotates our own client-facing handle
// too. Any failure along the way revokes the whole family, not just the
// presented token.
export async function rotateSession(presentedHandle: string): Promise<RotateResult> {
  const session = await ToolsSession.findOne({
    refreshHandleHash: hashHandle(presentedHandle),
  });

  if (!session) {
    return { ok: false, reason: "invalid", message: "Session not found - please log in again." };
  }

  if (session.revoked) {
    // Presenting a handle we've already rotated past is a reuse/compromise
    // signal - kill the entire family, not just this one token.
    await revokeFamily(session.familyId);
    return { ok: false, reason: "reused", message: "Session was revoked - please log in again." };
  }

  if (Date.now() - session.sessionStartedAt.getTime() > SESSION_CEILING_MS) {
    await revokeFamily(session.familyId);
    return { ok: false, reason: "expired", message: "Session expired - please log in again." };
  }

  let fresh: ToolsSsoResult;
  try {
    fresh = await refreshEveSession(decrypt(session.eveRefreshTokenEncrypted));
  } catch {
    // CCP rejected the stored refresh token (revoked/expired on their end) -
    // nothing left to rotate to.
    await revokeFamily(session.familyId);
    return { ok: false, reason: "invalid", message: "EVE session expired - please log in again." };
  }

  if (!(await isCorpAllowed(fresh.corporationId))) {
    await revokeFamily(session.familyId);
    return {
      ok: false,
      reason: "corp_not_allowed",
      message: "Your corporation is no longer authorized to use this tool.",
    };
  }

  await ToolsUser.updateOne(
    { characterId: fresh.characterId },
    { characterName: fresh.characterName, corporationId: fresh.corporationId },
  );

  session.revoked = true;
  await session.save();

  const refreshHandle = generateRefreshHandle();
  await ToolsSession.create({
    familyId: session.familyId,
    characterId: session.characterId,
    refreshHandleHash: hashHandle(refreshHandle),
    eveRefreshTokenEncrypted: encrypt(fresh.eveRefreshToken),
    sessionStartedAt: session.sessionStartedAt,
    revoked: false,
  });

  const { token, expiresIn } = signAccessToken(toPayload(fresh));

  return {
    ok: true,
    refreshHandle,
    accessToken: token,
    expiresIn,
    character: toPayload(fresh),
  };
}

export async function revokeSessionFamilyByHandle(presentedHandle: string): Promise<void> {
  const session = await ToolsSession.findOne({
    refreshHandleHash: hashHandle(presentedHandle),
  });
  if (session) await revokeFamily(session.familyId);
}

export async function revokeAllSessionsForCharacter(characterId: string): Promise<void> {
  await ToolsSession.updateMany({ characterId }, { revoked: true });
}
