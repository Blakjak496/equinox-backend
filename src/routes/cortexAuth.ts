import crypto from "crypto";
import { Router, Response } from "express";
import { generatePkceChallenge, buildAuthorizeUrl, exchangeCortexCode } from "../services/cortexSso";
import {
  handleCortexCallback,
  unlinkCharacter,
  switchActiveCharacter,
  getAccountCharacters,
  deleteAccount,
} from "../services/cortexAuth";
import {
  setOAuthStateCookie,
  consumeOAuthStateCookie,
  setSessionCookie,
  clearSessionCookie,
  getCortexSession,
  requireCortexAuth,
  CortexAuthedRequest,
} from "../lib/cortexSession";

const cortexAuthRouter = Router();

function getFrontendUrl(): string {
  const url = process.env.CORTEX_FRONTEND_URL;
  if (!url) throw new Error("CORTEX_FRONTEND_URL environment variable is not set");
  return url;
}

// /login and /link both just start the same redirect - callback decides the outcome
function startAuth(res: Response): void {
  const state = crypto.randomBytes(16).toString("base64url");
  const pkce = generatePkceChallenge();

  setOAuthStateCookie(res, { state, codeVerifier: pkce.verifier });
  res.redirect(buildAuthorizeUrl(state, pkce));
}

cortexAuthRouter.get("/login", (_req, res) => startAuth(res));
cortexAuthRouter.get("/link", (_req, res) => startAuth(res));

cortexAuthRouter.get("/callback", async (req, res) => {
  const frontendUrl = getFrontendUrl();

  if (req.query.error) {
    res.redirect(`${frontendUrl}?authError=sso_denied`);
    return;
  }

  const code = req.query.code;
  const state = req.query.state;
  const oauthState = consumeOAuthStateCookie(req, res);

  if (
    typeof code !== "string" ||
    typeof state !== "string" ||
    !oauthState ||
    oauthState.state !== state
  ) {
    res.redirect(`${frontendUrl}?authError=invalid_state`);
    return;
  }

  try {
    const sso = await exchangeCortexCode(code, oauthState.codeVerifier);
    const existingSession = getCortexSession(req);
    const outcome = await handleCortexCallback(sso, existingSession);

    if (!outcome.ok) {
      res.redirect(`${frontendUrl}?authError=${outcome.reason}`);
      return;
    }

    setSessionCookie(res, outcome.session);
    res.redirect(frontendUrl);
  } catch (err) {
    console.error("[cortexAuth] SSO callback failed:", err);
    res.redirect(`${frontendUrl}?authError=sso_failed`);
  }
});

cortexAuthRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
});

cortexAuthRouter.get("/me", requireCortexAuth, async (req, res) => {
  const session = (req as CortexAuthedRequest).cortexSession;
  const characters = await getAccountCharacters(session.accountId);
  res.status(200).json({
    ok: true,
    data: {
      accountId: session.accountId,
      activeCharacterId: session.activeCharacterId,
      characters,
    },
  });
});

cortexAuthRouter.post("/active-character", requireCortexAuth, async (req, res) => {
  const session = (req as CortexAuthedRequest).cortexSession;
  const { characterId } = req.body ?? {};

  if (typeof characterId !== "string") {
    res.status(400).json({ ok: false, message: "characterId is required" });
    return;
  }

  const outcome = await switchActiveCharacter(session, characterId);
  if (!outcome.ok) {
    res.status(outcome.reason === "not_found" ? 404 : 403).json({ ok: false, reason: outcome.reason });
    return;
  }

  setSessionCookie(res, outcome.session);
  res.status(200).json({ ok: true, data: outcome.session });
});

cortexAuthRouter.delete("/characters/:id", requireCortexAuth, async (req, res) => {
  const session = (req as CortexAuthedRequest).cortexSession;
  const characterId = String(req.params.id);
  const outcome = await unlinkCharacter(session, characterId);

  if (!outcome.ok) {
    res.status(outcome.reason === "not_found" ? 404 : 403).json({ ok: false, reason: outcome.reason });
    return;
  }

  if (outcome.loggedOut) {
    clearSessionCookie(res);
    res.status(200).json({ ok: true, loggedOut: true });
    return;
  }

  setSessionCookie(res, outcome.session);
  res.status(200).json({ ok: true, loggedOut: false, data: outcome.session });
});

cortexAuthRouter.delete("/account", requireCortexAuth, async (req, res) => {
  const session = (req as CortexAuthedRequest).cortexSession;
  await deleteAccount(session);
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
});

export default cortexAuthRouter;
