import crypto from "crypto";
import { Request, Response, NextFunction } from "express";

const SESSION_COOKIE = "cortex_session";
const OAUTH_STATE_COOKIE = "cortex_oauth_state";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

function getSessionSecret(): string {
  const secret = process.env.CORTEX_SESSION_SECRET;
  if (!secret) throw new Error("CORTEX_SESSION_SECRET environment variable is not set");
  return secret;
}

function sign(payload: object, ttlSeconds: number): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedBody = Buffer.from(JSON.stringify(body)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", getSessionSecret())
    .update(`${encodedHeader}.${encodedBody}`)
    .digest("base64url");

  return `${encodedHeader}.${encodedBody}.${signature}`;
}

function verify<T>(token: string): (T & { iat: number; exp: number }) | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedBody, signature] = parts;

    const expectedSignature = crypto
      .createHmac("sha256", getSessionSecret())
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

    return body;
  } catch {
    return null;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};

  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function setCookie(res: Response, name: string, value: string, maxAgeSeconds: number): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  // production only - Secure requires HTTPS, local dev runs on http://
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function clearCookie(res: Response, name: string): void {
  res.append("Set-Cookie", `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export type CortexSessionPayload = {
  accountId: string;
  activeCharacterId: string;
};

export function setSessionCookie(res: Response, payload: CortexSessionPayload): void {
  setCookie(res, SESSION_COOKIE, sign(payload, SESSION_TTL_SECONDS), SESSION_TTL_SECONDS);
}

export function clearSessionCookie(res: Response): void {
  clearCookie(res, SESSION_COOKIE);
}

export function getCortexSession(req: Request): CortexSessionPayload | null {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const payload = verify<CortexSessionPayload>(token);
  if (!payload) return null;
  return { accountId: payload.accountId, activeCharacterId: payload.activeCharacterId };
}

export interface CortexAuthedRequest extends Request {
  cortexSession: CortexSessionPayload;
}

export function requireCortexAuth(req: Request, res: Response, next: NextFunction) {
  const session = getCortexSession(req);
  if (!session) {
    res.status(401).json({ ok: false, message: "Not logged in" });
    return;
  }
  (req as CortexAuthedRequest).cortexSession = session;
  next();
}

export type OAuthStatePayload = {
  state: string;
  codeVerifier: string;
};

export function setOAuthStateCookie(res: Response, payload: OAuthStatePayload): void {
  setCookie(
    res,
    OAUTH_STATE_COOKIE,
    sign(payload, OAUTH_STATE_TTL_SECONDS),
    OAUTH_STATE_TTL_SECONDS,
  );
}

export function consumeOAuthStateCookie(req: Request, res: Response): OAuthStatePayload | null {
  const token = parseCookies(req)[OAUTH_STATE_COOKIE];
  clearCookie(res, OAUTH_STATE_COOKIE);
  if (!token) return null;
  const payload = verify<OAuthStatePayload>(token);
  if (!payload) return null;
  return { state: payload.state, codeVerifier: payload.codeVerifier };
}
