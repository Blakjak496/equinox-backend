import { Router } from "express";
import { exchangeToolsCode } from "../services/toolsSso";
import {
  createSessionFamily,
  rotateSession,
  revokeSessionFamilyByHandle,
  revokeAllSessionsForCharacter,
  requireToolsAuth,
  isCorpAllowed,
  ToolsAuthedRequest,
} from "../lib/toolsAuth";

const toolsAuthRouter = Router();

toolsAuthRouter.post("/login", async (req, res) => {
  const { code, codeVerifier, redirectUri } = req.body ?? {};

  if (!code || !codeVerifier || !redirectUri) {
    res.status(400).json({
      ok: false,
      message: "code, codeVerifier, and redirectUri are all required",
    });
    return;
  }

  try {
    const sso = await exchangeToolsCode(code, codeVerifier, redirectUri);

    if (!(await isCorpAllowed(sso.corporationId))) {
      res.status(403).json({
        ok: false,
        reason: "corp_not_allowed",
        message: "Your corporation is not authorized to use this tool.",
      });
      return;
    }

    const session = await createSessionFamily(sso);
    res.status(200).json({
      ok: true,
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      refreshToken: session.refreshHandle,
      character: session.character,
    });
  } catch (err) {
    console.error("Tools SSO login failed:", err);
    res.status(500).json({ ok: false, message: "SSO login failed" });
  }
});

toolsAuthRouter.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body ?? {};

  if (!refreshToken) {
    res.status(400).json({ ok: false, message: "refreshToken is required" });
    return;
  }

  try {
    const result = await rotateSession(refreshToken);
    if (!result.ok) {
      res.status(401).json({ ok: false, reason: result.reason, message: result.message });
      return;
    }

    res.status(200).json({
      ok: true,
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      refreshToken: result.refreshHandle,
      character: result.character,
    });
  } catch (err) {
    console.error("Tools session refresh failed:", err);
    res.status(500).json({ ok: false, message: "Session refresh failed" });
  }
});

toolsAuthRouter.post("/logout", async (req, res) => {
  const { refreshToken } = req.body ?? {};

  if (refreshToken) {
    try {
      await revokeSessionFamilyByHandle(refreshToken);
    } catch (err) {
      console.error("Tools logout failed:", err);
    }
  }

  res.status(200).json({ ok: true });
});

toolsAuthRouter.post("/logout-everywhere", requireToolsAuth, async (req, res) => {
  try {
    await revokeAllSessionsForCharacter((req as ToolsAuthedRequest).toolsUser!.characterId);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Tools logout-everywhere failed:", err);
    res.status(500).json({ ok: false, message: "Failed to log out everywhere" });
  }
});

toolsAuthRouter.get("/me", requireToolsAuth, (req, res) => {
  res.status(200).json({ ok: true, data: (req as ToolsAuthedRequest).toolsUser });
});

export default toolsAuthRouter;
