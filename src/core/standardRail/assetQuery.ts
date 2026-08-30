import { randomBytes } from "node:crypto";
import { getAddress, type Hex } from "viem";
import { pool } from "../db/pool.js";
import { listAssetsForStandardPayer } from "../db/queries/assetOwnership.js";
import { assertExactKeys, canonicalHash } from "./canonical.js";
import { decryptCursor, encryptCursor } from "./cursor.js";
import type { ProviderStandardRailConfig } from "./config.js";
import type {
  ProviderAssetQueryResponseV1,
  ProviderWalletActionGrantV1,
  SignedEnvelope,
} from "./types.js";
import type { ProviderWalletConfig } from "./walletConfig.js";
import {
  requestHash,
  utf8Hash,
  verifyProviderGrant,
  verifyWalletAuthorization,
  ZERO_HASH,
  type WalletAuthorizationTransport,
} from "./walletAuthorization.js";
import { signProviderResponse } from "./providerResponse.js";
import { consumeAssetEndpointRate } from "./assetRateLimit.js";
import { assertProviderWalletAvailable } from "./walletConfig.js";

interface AssetQueryRequestV1 {
  limit: number;
  cursor: string | null;
}

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export class ProviderAssetQueryService {
  constructor(
    private readonly standard: ProviderStandardRailConfig,
    private readonly wallet: ProviderWalletConfig,
    private readonly chainId: number,
  ) {}

  async query(input: unknown): Promise<SignedEnvelope<ProviderAssetQueryResponseV1>> {
    await assertProviderWalletAvailable(this.wallet);
    assertExactKeys(input, ["request", "authorization", "grant"], "asset query");
    const body = input as {
      request: AssetQueryRequestV1;
      authorization: WalletAuthorizationTransport;
      grant: SignedEnvelope<ProviderWalletActionGrantV1>;
    };
    assertExactKeys(body.request, ["limit", "cursor"], "asset query request");
    if (
      !Number.isSafeInteger(body.request.limit) || body.request.limit < 1 || body.request.limit > 100 ||
      !(body.request.cursor === null || typeof body.request.cursor === "string")
    ) throw new Error("asset query denied");
    const canonicalRequestHash = requestHash(body.request);
    const actionHash = utf8Hash("list-assets");
    const walletHash = await verifyWalletAuthorization({
      authorization: body.authorization,
      chainId: this.chainId,
      expectedPayer: getAddress(body.grant.payload.payer),
      expectedActionHash: actionHash,
      expectedAudienceHash: utf8Hash(this.standard.gatewayAudience),
    });
    const grantHash = await verifyProviderGrant({
      envelope: body.grant,
      environment: this.standard.environment,
      chainId: this.chainId,
      providerAudience: this.standard.providerAudience,
      gatewayLifecycleSigner: this.standard.gatewayLifecycleSigner,
    });
    this.validateBindings(body, walletHash, canonicalRequestHash, actionHash);
    await this.consumeAuthorizations(body, walletHash, grantHash, actionHash);

    const payer = getAddress(body.grant.payload.payer).toLowerCase() as Hex;
    const cursorQueryHash = canonicalHash({
      kind: "provider-assets", sort: "created_at-desc,id-desc", limit: body.request.limit,
    });
    const cursorBinding = {
      kind: "provider-assets",
      environment: this.standard.environment,
      chainId: this.chainId,
      issuer: this.standard.providerAudience,
      audience: this.standard.gatewayAudience,
      payer: payer.toLowerCase() as Hex,
      providerAgentId: this.wallet.providerAgentId,
      queryHash: cursorQueryHash,
    };
    const after = body.request.cursor === null ? undefined : decryptCursor({
      token: body.request.cursor,
      binding: cursorBinding,
      keyRing: this.wallet.cursorKeyRing,
    });
    const page = await listAssetsForStandardPayer({
      payer,
      limit: body.request.limit,
      after: after ? { createdAt: after.createdAt, id: after.id } : undefined,
    });
    const tail = page.assets.at(-1);
    const nextCursor = page.hasMore && tail ? encryptCursor({
      binding: cursorBinding,
      last: { createdAt: tail.created_at_cursor, id: tail.id },
      keyRing: this.wallet.cursorKeyRing,
      ttlSeconds: Math.min(900, this.wallet.admission.validBefore - Math.floor(Date.now() / 1_000)),
    }) : null;
    const payload: ProviderAssetQueryResponseV1 = {
      providerAgentId: this.wallet.providerAgentId,
      payer,
      assets: page.assets.map((asset) => ({
        providerAssetId: asset.id,
        serviceSlug: asset.service_slug,
        type: asset.type,
        identifier: asset.identifier,
        status: asset.status,
        createdAt: asset.created_at.toISOString(),
        expiresAt: asset.expires_at?.toISOString() ?? null,
      })),
      nextCursor,
      responseNonce: `0x${randomBytes(32).toString("hex")}`,
      requestHash: canonicalRequestHash,
      walletAuthorizationHash: walletHash,
      grantHash,
      providerControlProfileHash: this.wallet.providerControlProfileHash,
      servicingAdmissionHash: this.wallet.servicingAdmissionHash,
      servicingProfileEpoch: this.wallet.admission.servicingProfileEpoch,
    };
    return this.signResponse(payload, body.grant.validBefore);
  }

  private validateBindings(
    body: {
      request: AssetQueryRequestV1;
      authorization: WalletAuthorizationTransport;
      grant: SignedEnvelope<ProviderWalletActionGrantV1>;
    },
    walletHash: Hex,
    canonicalRequestHash: Hex,
    actionHash: Hex,
  ): void {
    const message = body.authorization.message;
    const grant = body.grant.payload;
    // The wallet signs the gateway-level query pre-image
    // {providerAgentId, limit, cursor}: scoped to this provider, or a
    // null-scoped first-page fan-out (the gateway admits a null scope only
    // with a null cursor). The per-provider body behind canonicalRequestHash
    // drops providerAgentId, so the wallet binding is checked against the
    // reconstructed candidates.
    const walletRequestHashes = [
      requestHash({
        providerAgentId: this.wallet.providerAgentId,
        limit: body.request.limit,
        cursor: body.request.cursor,
      }),
      ...(body.request.cursor === null
        ? [requestHash({ providerAgentId: null, limit: body.request.limit, cursor: null })]
        : []),
    ];
    if (
      !walletRequestHashes.includes(message.requestHash) ||
      message.providerAgentId !== "0" || message.serviceId !== ZERO_HASH ||
      message.providerControlProfileHash !== ZERO_HASH || message.servicingAdmissionHash !== ZERO_HASH ||
      message.actionCatalogHash !== ZERO_HASH || message.actionCatalogSchemaHash !== ZERO_HASH ||
      message.actionDefinitionHash !== ZERO_HASH || message.actionCatalogEpoch !== 0 ||
      message.methodHash !== utf8Hash("POST") || grant.providerAgentId !== this.wallet.providerAgentId ||
      message.absoluteResourceUriHash !== utf8Hash(this.wallet.gatewayAssetQueryUrl) ||
      grant.payer !== message.payer || grant.actionHash !== actionHash ||
      grant.methodHash !== message.methodHash || grant.absoluteResourceUriHash !== message.absoluteResourceUriHash ||
      grant.requestHash !== canonicalRequestHash || grant.walletAuthorizationHash !== walletHash ||
      grant.providerControlProfileHash !== this.wallet.providerControlProfileHash ||
      grant.servicingAdmissionHash !== this.wallet.servicingAdmissionHash ||
      grant.servicingProfileEpoch !== this.wallet.admission.servicingProfileEpoch ||
      grant.serviceId !== ZERO_HASH || grant.actionCatalogHash !== ZERO_HASH ||
      grant.actionCatalogSchemaHash !== ZERO_HASH || grant.actionCatalogEpoch !== 0 ||
      grant.actionDefinitionHash !== ZERO_HASH ||
      grant.gatewayAudienceHash !== utf8Hash(this.standard.gatewayAudience) ||
      grant.providerAudienceHash !== utf8Hash(this.standard.providerAudience)
    ) throw new Error("asset query denied");
  }

  private async consumeAuthorizations(
    body: { authorization: WalletAuthorizationTransport; grant: SignedEnvelope<ProviderWalletActionGrantV1> },
    walletHash: Hex,
    grantHash: Hex,
    actionHash: Hex,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await consumeAssetEndpointRate({
        db: client,
        gatewaySigner: this.standard.gatewayLifecycleSigner,
        payer: getAddress(body.grant.payload.payer),
        actionId: "list-assets",
        limits: this.wallet.abuse,
      });
      await client.query(
        `INSERT INTO standard_wallet_action_nonces
          (payer,nonce,action_hash,request_hash,wallet_authorization_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        [body.grant.payload.payer, bytes(body.authorization.message.nonce), bytes(actionHash),
          bytes(body.authorization.message.requestHash), bytes(walletHash)],
      );
      await client.query(
        `INSERT INTO standard_provider_grant_nonces(grant_nonce,grant_hash,payer)
         VALUES ($1,$2,$3)`,
        [bytes(body.grant.payload.grantNonce), bytes(grantHash), body.grant.payload.payer],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async signResponse(
    payload: ProviderAssetQueryResponseV1,
    grantDeadline: number,
  ): Promise<SignedEnvelope<ProviderAssetQueryResponseV1>> {
    return signProviderResponse({
      artifactType: "ProviderAssetQueryResponseV1",
      payload,
      standard: this.standard,
      wallet: this.wallet,
      chainId: this.chainId,
      grantDeadline,
    });
  }
}
