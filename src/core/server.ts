import express, {
  Router,
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { assertNoDuplicateJsonKeys } from "./standardRail/canonical.js";
import { config } from "./config.js";
import { healthRouter } from "./health.js";
import { wellKnownRouter } from "./agentCards/wellKnown.js";
import { postmarkWebhookRouter } from "./email/postmarkInbound.js";
import { getAllServices } from "./serviceRegistry/registry.js";
import { makeRateLimiter } from "./security/rateLimit.js";
import { logError, logInfo } from "./logger.js";
import { installHttpSecurityBoundary } from "./security/httpBoundary.js";
import { installCorsBoundary } from "./security/corsBoundary.js";
import { requireCurrentProviderIdentity } from "./security/providerIdentityBoundary.js";
import {
  concurrencyBudget,
  configureHttpTimeouts,
} from "./security/httpCapacity.js";
import { createStandardRailRouter } from "./standardRail/routes.js";
import { a2aRouter } from "./a2a/router.js";
import { agentCardRouter } from "./agentCards/routes.js";
import { adminRouter } from "./admin/routes.js";
import { skillsDocsRouter } from "./docs/skillsRouter.js";
import { applyOnlyToOpenFreeRequests } from "./security/openA2aBoundary.js";
import { fileURLToPath } from "node:url";
import type { ProviderStandardRailConfig } from "./standardRail/config.js";
import type { ProviderWalletConfig } from "./standardRail/walletConfig.js";

let server: ReturnType<Express["listen"]> | null = null;

export async function startServer(
  standardRailConfig: ProviderStandardRailConfig,
  walletConfig?: ProviderWalletConfig,
): Promise<void> {
  const app = express();
  installHttpSecurityBoundary(app);
  app.use("/admin", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    next();
  });
  // Liveness stays dependency-free. Production's required edge limiter is
  // the cross-replica boundary; this local limiter protects direct access.
  app.use("/health", localHealthLimiter());
  app.use("/health", healthRouter);

  const bypassIps = splitCsv(config.RATE_LIMIT_BYPASS_IPS);
  app.use(concurrencyBudget({
    maxConcurrent: config.HTTP_MAX_CONCURRENCY,
    maxConcurrentPerIp: config.HTTP_MAX_CONCURRENCY_PER_IP,
    bypassIps,
  }));
  const globalLimiter = makeRateLimiter({
    namespace: "global",
    capacity: config.RATE_LIMIT_GLOBAL_CAPACITY,
    perMinute: config.RATE_LIMIT_GLOBAL_PER_MIN,
    bypassIps,
  });
  app.use(globalLimiter);
  installCorsBoundary(app);
  const webhookLimiter = makeRateLimiter({
    namespace: "webhook",
    capacity: config.RATE_LIMIT_WEBHOOK_CAPACITY,
    perMinute: config.RATE_LIMIT_WEBHOOK_PER_MIN,
    bypassIps,
  });
  const authLimiter = makeRateLimiter({
    namespace: "auth",
    capacity: 20,
    perMinute: 10,
    bypassIps: [],
  });
  // Reject abusive authentication and webhook traffic before allocating
  // memory to JSON parsing. SIWE additionally uses a much smaller parser.
  app.use("/admin/ui/login", authLimiter);
  app.use("/admin/ui/login/verify", express.json({ limit: "16kb" }));
  app.use("/webhooks", webhookLimiter);
  // Capture the raw request body alongside the parsed JSON. The Postmark
  // inbound webhook verifies an optional HMAC over the exact bytes
  // received (re-serializing req.body wouldn't byte-match), so the raw
  // buffer must be stashed here at parse time. See
  // src/core/email/postmarkAuth.ts.
  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
  };
  app.use(
    "/webhooks/postmark/inbound",
    express.json({
      limit: `${config.POSTMARK_INBOUND_MAX_REQUEST_BYTES}b`,
      inflate: false,
      verify: captureRawBody,
    }),
  );
  app.use(
    "/standard-rail",
    (req, res, next) => {
      if (req.method !== "POST" && req.method !== "PUT") {
        next();
        return;
      }
      const mediaType = req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      const encoding = req.header("content-encoding")?.trim().toLowerCase();
      if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
        res.status(415).json({ error: "uncompressed_application_json_required" });
        return;
      }
      next();
    },
    express.json({
      limit: "2mb",
      inflate: false,
      verify: captureRawBody,
    }),
  );
  app.use(
    "/a2a",
    express.json({
      limit: `${config.A2A_MAX_BODY_BYTES}b`,
      verify: captureRawBody,
    }),
  );
  app.use(
    express.json({
      limit: "1mb",
      verify: captureRawBody,
    }),
  );
  app.use((req, res, next) => {
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody?.length) {
      next();
      return;
    }
    try {
      assertNoDuplicateJsonKeys(rawBody.toString("utf8"));
      next();
    } catch {
      res.status(400).json({ error: "duplicate_json_key" });
    }
  });

  app.use(
    "/admin/ui/static",
    express.static(fileURLToPath(new URL("./admin/ui/static", import.meta.url)), {
      fallthrough: true,
      immutable: true,
      maxAge: "1h",
    }),
  );

  // Service-owned routes and direct public free-skill calls have separate
  // limits so one surface cannot consume the other's budget.
  // Operator can whitelist gateway egress IPs via RATE_LIMIT_BYPASS_IPS
  // so server-to-server traffic doesn't share a bucket with anonymous
  // callers.
  const serviceLimiter = makeRateLimiter({
    namespace: "service",
    capacity: config.RATE_LIMIT_SERVICE_CAPACITY,
    perMinute: config.RATE_LIMIT_SERVICE_PER_MIN,
    bypassIps,
  });
  const a2aLimiter = makeRateLimiter({
    namespace: "a2a",
    capacity: config.RATE_LIMIT_A2A_CAPACITY,
    perMinute: config.RATE_LIMIT_A2A_PER_MIN,
    bypassIps,
  });
  const openA2aLimiter = makeRateLimiter({
    namespace: "a2a-open",
    capacity: config.RATE_LIMIT_A2A_OPEN_CAPACITY,
    perMinute: config.RATE_LIMIT_A2A_OPEN_PER_MIN,
    bypassIps: [],
  });
  app.use("/.well-known", wellKnownRouter);
  app.use("/agent-cards", agentCardRouter);
  app.use(
    "/a2a",
    applyOnlyToOpenFreeRequests(openA2aLimiter),
    a2aLimiter,
    a2aRouter,
  );
  app.use("/skills", skillsDocsRouter);
  app.use("/admin", adminRouter);
  app.use(
    "/standard-rail",
    a2aLimiter,
    createStandardRailRouter(config, standardRailConfig, walletConfig),
  );
  app.use("/webhooks", postmarkWebhookRouter);
  app.use("/services", requireCurrentProviderIdentity);

  // Service-mounted routes: each ServiceModule.protocol.routes hook attaches
  // additional Express handlers under /services/<slug>/ behind the dedicated
  // service-route limiter.
  for (const module of getAllServices()) {
    if (module.protocol.routes) {
      const r = Router();
      module.protocol.routes(r);
      app.use(`/services/${module.manifest.slug}`, serviceLimiter, r);
    }
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logError("HTTP request failed", { error: (err as Error).message });
    if (res.headersSent) return;
    const status = (err as { status?: number }).status;
    if (status === 413) {
      res.status(413).json({ error: "request_too_large" });
      return;
    }
    res.status(500).json({ error: "internal_error" });
  });

  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      listening.off("error", reject);
      logInfo(`Server listening on port ${config.PORT}`, {
        baseUrl: config.BASE_URL,
      });
      resolve();
    };
    const listening = config.CHAIN_MODE === "mock"
      ? app.listen(config.PORT, "127.0.0.1", onListening)
      : app.listen(config.PORT, onListening);
    configureHttpTimeouts(listening);
    listening.once("error", reject);
    server = listening;
  });
}

export async function stopServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server!.close(() => resolve());
  });
  server = null;
}

function splitCsv(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function localHealthLimiter() {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = req.socket.remoteAddress ?? "unknown";
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + 60_000 }
      : current;
    bucket.count++;
    buckets.set(key, bucket);
    if (bucket.count > config.RATE_LIMIT_HEALTH_CAPACITY) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000))));
      res.status(429).json({ error: "rate_limit_exceeded" });
      return;
    }
    if (buckets.size > 10_000) {
      for (const [ip, value] of buckets) if (value.resetAt <= now) buckets.delete(ip);
      while (buckets.size > 10_000) {
        const oldest = buckets.keys().next().value as string | undefined;
        if (!oldest) break;
        buckets.delete(oldest);
      }
    }
    next();
  };
}
