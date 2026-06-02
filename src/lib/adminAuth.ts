import { Request, Response, NextFunction } from "express";

export function adminAuth(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers["x-admin-secret"];

  if (secret !== process.env.ADMIN_SECRET) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  next();
}
