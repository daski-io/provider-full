import pg from "pg";
import {
  isPlaceholder,
  redactDiagnosticMessage,
  result,
} from "./common.mjs";

const { Client } = pg;

export async function checkDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || isPlaceholder(connectionString)) {
    return result("DATABASE_REACHABLE", "fail", "DATABASE_URL is not usable");
  }
  let client;
  try {
    const { databaseTlsConfig, parseDatabaseSslMode } = await import(
      "../../src/core/db/tls.ts"
    );
    const sslMode = parseDatabaseSslMode(process.env.DATABASE_SSL_MODE);
    client = new Client({
      connectionString,
      ssl: databaseTlsConfig(sslMode, process.env.DATABASE_CA_CERT),
      connectionTimeoutMillis: 3_000,
      statement_timeout: 3_000,
      query_timeout: 3_000,
      application_name: "daski-provider-doctor",
    });
    await client.connect();
    const response = await client.query(
      "SELECT current_setting('server_version_num')::int AS version, " +
        "pg_is_in_recovery() AS recovery",
    );
    const version = Number(response.rows[0]?.version ?? 0);
    if (version < 160000) {
      return result(
        "DATABASE_REACHABLE",
        "fail",
        "PostgreSQL is reachable but older than version 16",
      );
    }
    return result(
      "DATABASE_REACHABLE",
      "pass",
      `PostgreSQL ${Math.floor(version / 10000)} is reachable with a read-only probe`,
    );
  } catch {
    return result(
      "DATABASE_REACHABLE",
      "fail",
      "PostgreSQL read-only probe failed",
      "Check DATABASE_URL, DATABASE_SSL_MODE, container health, and network " +
        "access. No migration was attempted.",
    );
  } finally {
    await client?.end().catch(() => undefined);
  }
}

export async function checkSignedArtifacts(stage, runtimeOk) {
  if (!runtimeOk) {
    return result(
      "SIGNED_ARTIFACTS",
      stage === "local" ? "warn" : "fail",
      "signed-artifact validation was blocked by core configuration",
    );
  }
  try {
    const [standardModule, walletModule, launchModule, servicesModule] =
      await Promise.all([
        import("../../src/core/standardRail/config.ts"),
        import("../../src/core/standardRail/walletConfig.ts"),
        import("../../src/core/standardRail/launchPolicy.ts"),
        import("../../src/providerServices.ts"),
      ]);
    const launchPolicy = launchModule.deriveProviderLaunchPolicy(
      servicesModule.providerServices,
    );
    const standard = await standardModule.loadProviderStandardRailConfig(
      launchPolicy,
      process.env,
    );
    const wallet = await walletModule.loadProviderWalletConfig(
      standard,
      launchPolicy,
      process.env,
    );
    if (wallet.providerAgentId !== process.env.PROVIDER_AGENT_ID) {
      throw new Error("signed wallet artifacts do not match PROVIDER_AGENT_ID");
    }
    const skills = new Set(servicesModule.providerServices.flatMap((service) =>
      service.skills.map((skill) => `${service.manifest.slug}/${skill.id}`)));
    for (const outcome of standard.outcomes.values()) {
      if (!skills.has(`${outcome.serviceSlug}/${outcome.skillId}`)) {
        throw new Error("signed outcome references an uninstalled service or skill");
      }
    }
    for (const action of wallet.catalog.actions) {
      const installed = servicesModule.providerServices.some(
        (service) => service.manifest.slug === action.serviceSlug,
      );
      if (!installed) throw new Error("signed action references an uninstalled service");
    }
    return result(
      "SIGNED_ARTIFACTS",
      "pass",
      "signatures, domains, runtime listings/actions, and service references validate",
    );
  } catch (error) {
    return result(
      "SIGNED_ARTIFACTS",
      stage === "local" ? "warn" : "fail",
      "signed standard-rail artifacts are unavailable or inconsistent",
      redactDiagnosticMessage(error),
    );
  }
}

function isLocalProviderTarget(url) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (url.protocol === "http:" || url.protocol === "https:")
    && !url.username
    && !url.password
    && !url.search
    && !url.hash
    && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1");
}

async function boundedJson(url, init, { allowLocalProvider = false } = {}) {
  if (allowLocalProvider) {
    if (!isLocalProviderTarget(url)) throw new Error("local provider probe target is invalid");
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > 65_536) throw new Error("response too large");
    const text = await response.text();
    if (Buffer.byteLength(text) > 65_536) throw new Error("response too large");
    return { response, body: JSON.parse(text) };
  }

  const { boundedFetch } = await import("../../src/core/security/outboundHttp.ts");
  const response = await boundedFetch(url, init, {
    timeoutMs: 5_000,
    maxResponseBytes: 65_536,
    allowedContentTypes: ["application/json"],
    publicTarget: {
      allowHttp: false,
      allowQueryOrFragment: true,
    },
  });
  return { response, body: response.json() };
}

export async function checkLiveProbes(stage) {
  const expectedChain = stage === "mainnet" ? 8453 : 84532;
  try {
    const base = new URL(process.env.BASE_URL);
    const rpc = new URL(process.env.BASE_RPC_URL);
    if ((stage !== "local" && base.protocol !== "https:") || rpc.protocol !== "https:") {
      throw new Error("live probe targets are not approved HTTPS URLs");
    }
    const [health, chain] = await Promise.all([
      boundedJson(new URL("/health/live", base), undefined, {
        allowLocalProvider: stage === "local" && isLocalProviderTarget(base),
      }),
      boundedJson(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      }),
    ]);
    if (!health.response.ok || typeof health.body !== "object") {
      throw new Error("provider liveness failed");
    }
    if (Number.parseInt(chain.body.result, 16) !== expectedChain) {
      throw new Error("RPC chain id mismatch");
    }
    return result(
      "LIVE_READ_ONLY_PROBES",
      "pass",
      "provider liveness and Base RPC chain id responded",
    );
  } catch (error) {
    return result(
      "LIVE_READ_ONLY_PROBES",
      "fail",
      "one or more opt-in live probes failed",
      redactDiagnosticMessage(error),
    );
  }
}
