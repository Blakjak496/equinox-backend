import { Router } from "express";
import { exchangeEveCode } from "../services/exchangeEveCode";
import { adminAuth } from "../lib/adminAuth";

const router = Router();

router.post("/eve", adminAuth, async (req, res) => {
  try {
    const args = { ...req.body };
    const code = args.code;
    const codeVerifier = args.codeVerifier;
    const redirectUri = args.redirectUri;

    const response = await exchangeEveCode(code, codeVerifier, redirectUri);

    res.json({ ok: response.ok });
  } catch (err) {
    console.error("Eve SSO exchange failed:", err);
    res.status(500).json({ ok: false, error: "SSO exchange failed" });
  }
});

export default router;
