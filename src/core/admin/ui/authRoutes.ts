import type { Request, Router } from "express";
import type { Hex } from "viem";
import { config } from "../../config.js";
import { createSession, deleteSession, revokeAllSessions } from "../../db/queries/sessions.js";
import {
  expectedSiweDomain,
  isAllowlistConfigured,
  issueSiweNonce,
  siwePayloadTooLarge,
  verifySiweSignIn,
} from "../../auth/siwe.js";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_COOKIE_PATH,
  clearAdminSessionCookie,
  readAdminSessionCookie,
} from "./sessionCookie.js";
import { renderLogin } from "./layouts.js";
import { getAdminWallet } from "./authMiddleware.js";
import { requestClientIp } from "../../security/rateLimit.js";

const NONCE_TTL_SECONDS = 5 * 60;

export function mountAdminAuthRoutes(router: Router): void {
  router.get("/login", (_req, res) => {
    const error = isAllowlistConfigured()
      ? undefined
      : "SIWE login is not configured. Set ADMIN_WALLET_ALLOWLIST in env to enable wallet sign-in.";
    res.type("html").send(renderLogin(error));
  });

  router.get("/login/nonce", async (req, res) => {
    if (!isAllowlistConfigured()) {
      res.status(503).json({ error: "siwe_not_configured" });
      return;
    }
    const issued = await issueSiweNonce(requestClientIp(req));
    if (!issued.ok) {
      res.status(issued.reason === "rate-limited" ? 429 : 503).json({ error: issued.reason });
      return;
    }
    res.json({
      nonce: issued.nonce,
      chainId: config.CHAIN_ID,
      domain: expectedSiweDomain(),
      expiresInSeconds: NONCE_TTL_SECONDS,
    });
  });

  router.post("/login/verify", async (req, res) => {
    if (!isAllowlistConfigured()) {
      res.status(503).json({ error: "siwe_not_configured" });
      return;
    }
    const body = (req as Request & { body?: { message?: string; signature?: string } }).body ?? {};
    if (typeof body.message !== "string" || typeof body.signature !== "string") {
      res.status(400).send("missing message or signature");
      return;
    }
    if (siwePayloadTooLarge(body.message, body.signature)) {
      res.status(413).send("SIWE payload too large");
      return;
    }
    const result = await verifySiweSignIn({
      message: body.message,
      signature: body.signature as Hex,
      requestIp: requestClientIp(req),
    });
    if (!result.ok) {
      res.status(result.reason === "rate-limited" ? 429 : 401).send(result.reason);
      return;
    }
    const expiresAt = new Date(Date.now() + config.ADMIN_UI_SESSION_HOURS * 3_600_000);
    const created = await createSession(result.address, expiresAt);
    const secure = new URL(config.BASE_URL).protocol === "https:" ? " Secure;" : "";
    res.setHeader(
      "Set-Cookie",
      `${ADMIN_SESSION_COOKIE}=${created.token}; Path=${ADMIN_SESSION_COOKIE_PATH}; HttpOnly; SameSite=Strict;${secure} Max-Age=${config.ADMIN_UI_SESSION_HOURS * 3_600}`,
    );
    res.status(204).end();
  });

  router.get("/logout", async (req, res) => {
    const cookie = readAdminSessionCookie(req.headers.cookie ?? "");
    if (cookie) await deleteSession(cookie);
    res.setHeader("Set-Cookie", clearAdminSessionCookie());
    res.redirect("/admin/ui/login");
  });

  router.post("/logout/all", async (req, res) => {
    const wallet = getAdminWallet(req);
    if (wallet) await revokeAllSessions(wallet);
    res.setHeader("Set-Cookie", clearAdminSessionCookie());
    res.redirect("/admin/ui/login");
  });
}
