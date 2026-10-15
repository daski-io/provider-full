import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { vi } from "vitest";
import type { FulfillmentAdapter, ServiceModule } from "../src/core/serviceRegistry/types.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type { ProviderWalletActionGrantV1, SignedEnvelope, WalletActionAuthorizationV1 } from "../src/core/standardRail/types.js";
import type { AssetActionDefinitionV1, ProviderWalletConfig } from "../src/core/standardRail/walletConfig.js";
import { createMigratedDatabase, type DisposableDatabase } from "./postgresHarness.js";
import { SERVICE_SLUG, seedFixtureService } from "./standardRailFixture.js";

/*
 * A synthetic wallet-action provider over a disposable PostgreSQL database:
 * real signed gateway grants and payer wallet authorizations, and the real
 * asset-action service, owner authority, fence, stores and finalization.
 * Test files own their vi.mock calls and delegate to the factories here.
 * Nothing here is a real gateway, provider, payer or product.
 */
export const assetWire = {
  pool: null as pg.Pool | null,
  adapter: null as unknown as FulfillmentAdapter,
  /** The synthetic service's asset facet (lookup statuses, input identifiers). */
  assets: {} as NonNullable<ServiceModule["assets"]>,
  /** Runs before each provider statement, e.g. to hold a transaction at one step. */
  beforeQuery: null as ((text: string) => Promise<void>) | null,
  /** The synthetic service's declared readiness invariant failures; none unless a test adds one. */
  readinessFailures: [] as string[],
};

async function hook(text: unknown): Promise<void> {
  if (assetWire.beforeQuery && typeof text === "string") await assetWire.beforeQuery(text);
}

/** `db/pool.js` over the disposable database, with a statement hook. */
export function poolModule() {
  return {
    pool: {
      query: async (...args: unknown[]) => {
        await hook(args[0]);
        return (assetWire.pool!.query as (...a: unknown[]) => unknown)(...args);
      },
      connect: async () => {
        const client = await assetWire.pool!.connect();
        const original = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        (client as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = async (...args) => {
          await hook(args[0]);
          return original(...args);
        };
        return client;
      },
    },
    migrationPool: { query: vi.fn(), connect: vi.fn() },
    closeMigrationPool: vi.fn(),
    checkDatabase: async () => true,
  };
}

export function registryModule() {
  return {
    getAdapter: () => assetWire.adapter,
    getService: (slug: string) => (slug === SERVICE_SLUG
      ? {
          manifest: { slug: SERVICE_SLUG, version: "1" },
          assets: assetWire.assets,
          operations: { readiness: { checkInvariants: async () => [...assetWire.readinessFailures] } },
        } as unknown as ServiceModule
      : null),
    getAllServices: () => [],
  };
}

export const CHAIN_ID = 84_532;
const hash = (nibble: string): Hex => `0x${nibble.repeat(64)}` as Hex;
const gateway = privateKeyToAccount(`0x${"31".repeat(32)}` as Hex);
const provider = privateKeyToAccount(`0x${"32".repeat(32)}` as Hex);
export const payerA = privateKeyToAccount(`0x${"33".repeat(32)}` as Hex);
export const payerB = privateKeyToAccount(`0x${"34".repeat(32)}` as Hex);
export const lower = (account: PrivateKeyAccount): Hex => account.address.toLowerCase() as Hex;

export const standard = {
  environment: "testnet",
  chainId: CHAIN_ID,
  gatewayAudience: "https://gateway.example",
  providerAudience: "https://provider.example",
  gatewayLifecycleSigner: gateway.address,
  gatewayDispatchSigner: gateway.address,
} as unknown as ProviderStandardRailConfig;

const nowSeconds = Math.floor(Date.now() / 1_000);
const noteResult = {
  type: "object",
  properties: { receipt: { type: "string", maxLength: 80 } },
  required: ["receipt"],
  additionalProperties: false,
};

function definition(actionId: string, overrides: Partial<AssetActionDefinitionV1> = {}): AssetActionDefinitionV1 {
  return {
    providerAgentId: "77", serviceId: hash("5"), serviceSlug: SERVICE_SLUG, actionId, assetType: "note",
    ownershipPolicy: "owner-only", destructive: false,
    requestSchema: {
      type: "object", properties: { note: { type: "string", maxLength: 80 } }, additionalProperties: false,
    },
    responseSchema: noteResult,
    confirmationSummarySchema: null, confirmationSummaryTemplate: null,
    endpoint: "https://provider.example/standard-rail/assets/action", replayPolicy: "stable-result",
    retentionSeconds: 7_200, validFrom: nowSeconds - 3_600, validBefore: nowSeconds + 86_400,
    actionDefinitionHash: hash("f"),
    ...overrides,
  };
}

export const ACTIONS = {
  touch: definition("touch-note", { actionDefinitionHash: hash("a") }),
  peek: definition("peek-note", { actionDefinitionHash: hash("b"), replayPolicy: "regenerate-ephemeral" }),
  remove: definition("remove-note", {
    actionDefinitionHash: hash("c"),
    destructive: true,
    confirmationSummarySchema: {
      type: "object",
      properties: { providerAssetId: { type: "string", maxLength: 64 }, effect: { type: "string", maxLength: 64 } },
      required: ["providerAssetId", "effect"],
      additionalProperties: false,
    },
    confirmationSummaryTemplate: { providerAssetId: "placeholder", effect: "permanent removal" },
  }),
} as const;
export const SKILL_IDS = Object.values(ACTIONS).map((action) => action.actionId);

export const wallet = {
  providerAgentId: "77",
  providerControlProfileHash: hash("1"),
  servicingAdmissionHash: hash("2"),
  admission: {
    providerAgentId: "77", providerControlProfileHash: hash("1"), servicingProfileEpoch: 3,
    actionCatalogHash: hash("3"), actionCatalogSchemaHash: hash("4"), actionCatalogEpoch: 0,
    servicingEnabled: true, previousAdmissionHash: hash("0"),
    validFrom: nowSeconds - 3_600, validBefore: nowSeconds + 86_400,
  },
  actionCatalogHash: hash("3"),
  catalog: {
    providerAgentId: "77", providerControlProfileHash: hash("1"), servicingProfileEpoch: 3,
    actionCatalogSchemaHash: hash("4"), actionCatalogEpoch: 0, actions: Object.values(ACTIONS),
  },
  assetResponsePrivateKey: `0x${"32".repeat(32)}` as Hex,
  assetResponseKey: provider.address,
  assetResponseKeyId: "provider-wallet",
  artifactValidBefore: nowSeconds + 86_400,
  destructiveActionDelaySeconds: 600,
  gatewayAssetQueryUrl: "https://gateway.example/wallet/assets",
  gatewayAssetActionUrl: "https://gateway.example/wallet/assets/action",
  abuse: {
    requestsPerGatewaySignerPerMinute: 1_000, requestsPerPayerPerMinute: 1_000,
    requestsPerActionPerMinute: 1_000, requestsGlobalPerMinute: 1_000,
    destructiveOutstandingPerPayer: 5, destructiveOutstandingPerProvider: 100, destructiveOutstandingGlobal: 1_000,
  },
} as unknown as ProviderWalletConfig;

const random32 = (): Hex => `0x${randomBytes(32).toString("hex")}` as Hex;

export interface SignedActionOptions {
  action: AssetActionDefinitionV1;
  providerAssetId: string;
  input: Record<string, unknown>;
  payer?: PrivateKeyAccount;
  /** Sign the wallet authorization with another key (an invalid signature). */
  signer?: PrivateKeyAccount;
  /** A raw signature in place of an EOA one (a contract-account signature). */
  signature?: Hex;
  nonce?: Hex;
  grantNonce?: Hex;
}

/** The exact body the gateway forwards: request, payer authorization and its own grant. */
export async function signedAction(options: SignedActionOptions) {
  const { walletAuthorizationHash, requestHash, utf8Hash } = await import("../src/core/standardRail/walletAuthorization.js");
  const { unsignedEnvelopeHash } = await import("../src/core/standardRail/canonical.js");
  const payer = options.payer ?? payerA;
  const now = Math.floor(Date.now() / 1_000);
  const operation = options.input.operation;
  const prefix = operation === "confirm-destructive" ? "confirm-destructive"
    : operation === "recover-action" ? "recover-action" : "use-asset";
  const request = { actionId: options.action.actionId, providerAssetId: options.providerAssetId, input: options.input };
  const message: WalletActionAuthorizationV1 = {
    payer: lower(payer), providerAgentId: "77", serviceId: options.action.serviceId,
    providerControlProfileHash: wallet.providerControlProfileHash, servicingAdmissionHash: wallet.servicingAdmissionHash,
    actionCatalogHash: wallet.actionCatalogHash, actionCatalogSchemaHash: wallet.admission.actionCatalogSchemaHash,
    actionDefinitionHash: options.action.actionDefinitionHash, actionCatalogEpoch: 0,
    actionHash: utf8Hash(`${prefix}:77:${options.action.actionId}`), methodHash: utf8Hash("POST"),
    absoluteResourceUriHash: utf8Hash(wallet.gatewayAssetActionUrl), requestHash: requestHash(request),
    audienceHash: utf8Hash(standard.gatewayAudience), nonce: options.nonce ?? random32(),
    issuedAt: now - 1, validBefore: now + 120,
  };
  const digest = walletAuthorizationHash(message, CHAIN_ID);
  const signature = options.signature ?? await (options.signer ?? payer).sign({ hash: digest });
  const grant: SignedEnvelope<ProviderWalletActionGrantV1> = {
    artifactType: "ProviderWalletActionGrantV1", schemaVersion: 1, environment: standard.environment,
    chainId: CHAIN_ID, audience: standard.providerAudience, signerKeyId: "gateway-lifecycle",
    issuedAt: now - 1, validBefore: now + 120,
    payload: {
      payer: message.payer, providerAgentId: "77", serviceId: message.serviceId, actionHash: message.actionHash,
      methodHash: message.methodHash, absoluteResourceUriHash: message.absoluteResourceUriHash,
      requestHash: message.requestHash, walletAuthorizationHash: digest,
      providerControlProfileHash: wallet.providerControlProfileHash, servicingAdmissionHash: wallet.servicingAdmissionHash,
      servicingProfileEpoch: 3, actionCatalogHash: wallet.actionCatalogHash,
      actionCatalogSchemaHash: wallet.admission.actionCatalogSchemaHash, actionCatalogEpoch: 0,
      actionDefinitionHash: options.action.actionDefinitionHash, gatewayAudienceHash: message.audienceHash,
      providerAudienceHash: utf8Hash(standard.providerAudience), grantNonce: options.grantNonce ?? random32(),
    },
    signature: "0x" as Hex,
  };
  grant.signature = await gateway.signMessage({
    message: { raw: unsignedEnvelopeHash(grant as unknown as Record<string, unknown>) },
  });
  return { request, authorization: { message, signature }, grant };
}

/** A signed wallet asset query, as the gateway forwards it for one provider. */
export async function signedQuery(options: {
  payer?: PrivateKeyAccount;
  signature?: Hex;
  limit?: number;
}) {
  const { walletAuthorizationHash, requestHash, utf8Hash, ZERO_HASH } = await import("../src/core/standardRail/walletAuthorization.js");
  const { unsignedEnvelopeHash } = await import("../src/core/standardRail/canonical.js");
  const payer = options.payer ?? payerA;
  const now = Math.floor(Date.now() / 1_000);
  const request = { limit: options.limit ?? 10, cursor: null };
  const message: WalletActionAuthorizationV1 = {
    payer: lower(payer), providerAgentId: "0", serviceId: ZERO_HASH,
    providerControlProfileHash: ZERO_HASH, servicingAdmissionHash: ZERO_HASH,
    actionCatalogHash: ZERO_HASH, actionCatalogSchemaHash: ZERO_HASH, actionDefinitionHash: ZERO_HASH,
    actionCatalogEpoch: 0, actionHash: utf8Hash("list-assets"), methodHash: utf8Hash("POST"),
    absoluteResourceUriHash: utf8Hash(wallet.gatewayAssetQueryUrl),
    requestHash: requestHash({ providerAgentId: "77", ...request }),
    audienceHash: utf8Hash(standard.gatewayAudience), nonce: random32(), issuedAt: now - 1, validBefore: now + 120,
  };
  const digest = walletAuthorizationHash(message, CHAIN_ID);
  const signature = options.signature ?? await payer.sign({ hash: digest });
  const grant: SignedEnvelope<ProviderWalletActionGrantV1> = {
    artifactType: "ProviderWalletActionGrantV1", schemaVersion: 1, environment: standard.environment,
    chainId: CHAIN_ID, audience: standard.providerAudience, signerKeyId: "gateway-lifecycle",
    issuedAt: now - 1, validBefore: now + 120,
    payload: {
      payer: message.payer, providerAgentId: "77", serviceId: ZERO_HASH, actionHash: message.actionHash,
      methodHash: message.methodHash, absoluteResourceUriHash: message.absoluteResourceUriHash,
      requestHash: requestHash(request), walletAuthorizationHash: digest,
      providerControlProfileHash: wallet.providerControlProfileHash, servicingAdmissionHash: wallet.servicingAdmissionHash,
      servicingProfileEpoch: 3, actionCatalogHash: ZERO_HASH, actionCatalogSchemaHash: ZERO_HASH,
      actionCatalogEpoch: 0, actionDefinitionHash: ZERO_HASH, gatewayAudienceHash: message.audienceHash,
      providerAudienceHash: utf8Hash(standard.providerAudience), grantNonce: random32(),
    },
    signature: "0x" as Hex,
  };
  grant.signature = await gateway.signMessage({
    message: { raw: unsignedEnvelopeHash(grant as unknown as Record<string, unknown>) },
  });
  return { request, authorization: { message, signature }, grant };
}

interface GrantedBody {
  authorization: { message: WalletActionAuthorizationV1 };
  grant: SignedEnvelope<ProviderWalletActionGrantV1>;
}

/** The same authorized request under a fresh gateway grant, as the gateway sends a retry. */
export async function regrant<T extends GrantedBody>(body: T): Promise<T> {
  const { unsignedEnvelopeHash } = await import("../src/core/standardRail/canonical.js");
  const now = Math.floor(Date.now() / 1_000);
  const grant: SignedEnvelope<ProviderWalletActionGrantV1> = {
    ...body.grant,
    issuedAt: now - 1,
    validBefore: Math.min(now + 120, body.authorization.message.validBefore),
    payload: { ...body.grant.payload, grantNonce: random32() },
    signature: "0x" as Hex,
  };
  grant.signature = await gateway.signMessage({
    message: { raw: unsignedEnvelopeHash(grant as unknown as Record<string, unknown>) },
  });
  return { ...body, grant };
}

export interface AssetHarness {
  database: DisposableDatabase;
  serviceId: string;
  /** A note asset whose current owner is `payer` through its creating standard order. */
  ownedNote(payer: PrivateKeyAccount, options?: { identifier?: string; status?: string; type?: string }): Promise<string>;
  /** A synthetic owner change, written the way a fork's owner swap must: under the fence. */
  changeOwner(assetId: string, payer: PrivateKeyAccount, version: number): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const KEPT_TABLES = new Set(["_migrations", "_service_migrations", "services", "skills"]);

export async function startAssetHarness(label: string): Promise<AssetHarness> {
  const database = await createMigratedDatabase(label);
  assetWire.pool = database.pool;
  const serviceId = await seedFixtureService(database.pool, { skillIds: SKILL_IDS });
  const { createAsset } = await import("../src/core/db/queries/assets.js");
  const { upsertCustomer } = await import("../src/core/db/queries/customers.js");
  return {
    database,
    serviceId,
    async ownedNote(payer, options = {}) {
      const asset = await createAsset({
        service_id: serviceId, type: options.type ?? "note",
        identifier: options.identifier ?? `note-${randomUUID().slice(0, 8)}`,
        status: (options.status ?? "active") as never,
      }, database.pool);
      const customer = await upsertCustomer(payer.address, database.pool);
      await database.pool.query(
        `INSERT INTO transactions (id,service_id,skill_id,status,asset_id,completed_at,customer_id,
           standard_order_id,standard_payer,standard_order_key,standard_token,standard_gross_amount,
           standard_provider_net_amount,standard_daski_commission_amount)
         VALUES ($1,$2,'touch-note','completed',$3,now(),$4,$5,$6,$7,'0x7777777777777777777777777777777777777777',
           1000,950,50)`,
        [`task-${randomUUID()}`, serviceId, asset.id, customer.id, `0x${randomBytes(32).toString("hex")}`,
          lower(payer), randomBytes(32)],
      );
      return asset.id;
    },
    async changeOwner(assetId, payer, version) {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('asset-owner:' || $1::text, 0))", [assetId]);
        await client.query(
          `INSERT INTO asset_owner_overrides(asset_id,payer,version) VALUES ($1,$2,$3)
           ON CONFLICT (asset_id) DO UPDATE SET payer=EXCLUDED.payer,version=EXCLUDED.version,updated_at=now()`,
          [assetId, lower(payer), version],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    },
    async reset() {
      assetWire.readinessFailures.length = 0;
      const tables = (await database.pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'",
      )).rows.map((row) => row.tablename).filter((table) => !KEPT_TABLES.has(table));
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(tables.map((table) => `DELETE FROM "${table}";`).join("\n"));
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    },
    async close() {
      await database.drop();
    },
  };
}
