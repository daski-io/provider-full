import { Router } from "express";
import { base, baseSepolia } from "viem/chains";
import type { Config } from "../config.js";
import { logError } from "../logger.js";
import { StandardDispatchService } from "./dispatch.js";
import { StandardLifecycleService } from "./lifecycle.js";
import { mountProtocolRoutes } from "./protocolRoutes.js";
import { StandardQuoteService } from "./quote.js";
import { assertExactKeys } from "./canonical.js";
import type { ProviderStandardRailConfig } from "./config.js";
import type { ProviderWalletConfig } from "./walletConfig.js";
import { ProviderAssetQueryService } from "./assetQuery.js";
import { ProviderAssetActionService } from "./assetAction.js";

export function createStandardRailRouter(
  core: Config,
  config: ProviderStandardRailConfig,
  walletConfig?: ProviderWalletConfig,
): Router {
  const chain = core.CHAIN_ID === 8453 ? base : baseSepolia;
  const dispatch = new StandardDispatchService(config, chain, core.CHAIN_ID);
  const lifecycle = new StandardLifecycleService(config, core.CHAIN_ID);
  const quote = new StandardQuoteService(config, core.CHAIN_ID);
  const assetQuery = walletConfig
    ? new ProviderAssetQueryService(config, walletConfig, core.CHAIN_ID)
    : null;
  const assetAction = walletConfig
    ? new ProviderAssetActionService(config, walletConfig, core.CHAIN_ID)
    : null;
  const router = Router();

  router.post("/assets/query", async (req, res) => {
    if (!assetQuery) {
      res.setHeader("Retry-After", "60");
      res.status(503).json({ error: { code: "PROVIDER_ASSET_QUERY_UNAVAILABLE" } });
      return;
    }
    try {
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.json(await assetQuery.query(req.body));
    } catch (error) {
      sendProviderAssetError(res, error);
    }
  });

  router.post("/assets/action", async (req, res) => {
    if (!assetAction) {
      res.setHeader("Retry-After", "60");
      res.status(503).json({ error: { code: "PROVIDER_ASSET_QUERY_UNAVAILABLE" } });
      return;
    }
    try {
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.json(await assetAction.perform(req.body));
    } catch (error) {
      sendProviderAssetError(res, error);
    }
  });

  router.get("/outcomes", async (_req, res, next) => {
    try {
      res.json({
      version: 1,
      providerAudience: config.providerAudience,
      outcomes: [...config.outcomes.values()].map((outcome) => ({
        outcomeId: outcome.outcomeId,
        serviceSlug: outcome.serviceSlug,
        skillId: outcome.skillId,
        listingManifestHash: outcome.listingManifestHash,
        providerOfferHash: outcome.providerOfferHash,
        bindingProfile: outcome.bindingProfile,
      })),
      });
    } catch (error) { next(error); }
  });

  mountProtocolRoutes(router, { quote, dispatch });

  router.post("/lifecycle", async (req, res) => {
    try {
      assertExactKeys(req.body, [
        "orderId", "providerTaskId", "action", "request", "authorization", "grant", "payer",
        "gatewayAudience",
      ], "lifecycle request");
      res.json(await lifecycle.perform(req.body as never));
    } catch (error) {
      logError("Standard lifecycle action rejected", {
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      res.status(401).json({ error: "lifecycle_rejected" });
    }
  });

  return router;
}

export function classifyProviderAssetError(error: unknown): {
  status: 403 | 429 | 503;
  code: "PROVIDER_ASSET_QUERY_REJECTED" | "PROVIDER_ASSET_QUERY_UNAVAILABLE";
  retryAfter: boolean;
  reasonClass: "rate_limited" | "dependency_unavailable" | "request_rejected";
} {
  const database = error as { code?: string };
  const message = error instanceof Error ? error.message : "provider asset request rejected";
  const rateLimited = /rate limit|capacity exceeded/i.test(message);
  const explicitlyRejected = /denied|invalid|mismatch|expired|stale|malformed|unsupported|required/i
    .test(message);
  const unavailable = !rateLimited && (!explicitlyRejected || database.code?.startsWith("08") === true ||
    database.code === "57P01" || /unavailable|runtime fence|servicing/i.test(message));
  const code = unavailable || rateLimited
    ? "PROVIDER_ASSET_QUERY_UNAVAILABLE"
    : "PROVIDER_ASSET_QUERY_REJECTED";
  return {
    status: rateLimited ? 429 : unavailable ? 503 : 403,
    code,
    retryAfter: unavailable || rateLimited,
    reasonClass: rateLimited ? "rate_limited"
      : unavailable ? "dependency_unavailable" : "request_rejected",
  };
}

function sendProviderAssetError(res: import("express").Response, error: unknown): void {
  const classified = classifyProviderAssetError(error);
  logError("Provider asset request failed", {
    errorClass: error instanceof Error ? error.name : "UnknownError",
    reasonClass: classified.reasonClass,
  });
  if (classified.retryAfter) res.setHeader("Retry-After", "60");
  res.status(classified.status).json({ error: { code: classified.code } });
}
