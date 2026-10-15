import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type pg from "pg";
import type { Hex } from "viem";
import type { Config } from "../src/core/config.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import type { ProviderStandardRailConfig } from "../src/core/standardRail/config.js";
import type { DispatchArgs } from "./dispatchWire.js";
import { signGatewayEnvelope } from "./gatewayConsumer.js";
import { CHAIN_ID, ENVIRONMENT, gatewayKey, PROVIDER_AUDIENCE } from "./standardRailFixture.js";

/** A real standard-rail ingress and router on an ephemeral loopback port. */
/**
 * Tests take new sales whatever this process's readiness and need no live
 * chain proof of the rail contracts; the gate tests set these themselves.
 */
export const OPEN_ADMISSION = {
  salesAdmission: async () => ({ status: "open" as const }),
  contractIntegrity: async () => undefined,
};

export async function startRailServer(
  railConfig: ProviderStandardRailConfig,
  options: {
    salesAdmission: () => Promise<{ status: "open" | "stopped" }>;
    contractIntegrity?: () => Promise<void>;
  } = OPEN_ADMISSION,
): Promise<{ base: string; close(): Promise<void> }> {
  const { createStandardRailRouter } = await import("../src/core/standardRail/routes.js");
  const { standardRailJsonIngress } = await import("../src/core/standardRail/transport.js");
  const app = express();
  app.use("/standard-rail", ...standardRailJsonIngress(),
    createStandardRailRouter({ CHAIN_ID } as Config, railConfig, undefined, options));
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/standard-rail`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function statusQuery(
  order: Pick<DispatchArgs, "dispatch">,
  options: { privateKey?: Hex; issuedAt?: number; dispatchHash?: Hex; artifactType?: string } = {},
) {
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1_000);
  return signGatewayEnvelope({
    artifactType: options.artifactType ?? "DispatchStatusQueryV1",
    environment: ENVIRONMENT, chainId: CHAIN_ID, audience: PROVIDER_AUDIENCE,
    signerKeyId: "gateway-dispatch", privateKey: options.privateKey ?? gatewayKey,
    issuedAt, validBefore: issuedAt + 60,
    payload: {
      orderId: order.dispatch.payload.orderId,
      dispatchHash: options.dispatchHash ?? canonicalHash(order.dispatch),
      issuedAt, validBefore: issuedAt + 60,
    },
  });
}

/**
 * Wrap pooled clients so the next admission transaction (the one that takes
 * the order's claim lock) fails its COMMIT, either after committing or
 * without committing, as a lost commit acknowledgement would look.
 */
export function faultyClient(client: pg.PoolClient, fault: { mode: "after" | "before" | null }): pg.PoolClient {
  const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
  let admission = false;
  (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
    const text = typeof args[0] === "string" ? args[0] : "";
    if (text.includes("pg_advisory_xact_lock(hashtextextended('standard-dispatch-claim:")) admission = true;
    if (admission && text === "COMMIT" && fault.mode) {
      const mode = fault.mode;
      fault.mode = null;
      admission = false;
      if (mode === "after") await query("COMMIT");
      throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" });
    }
    if (text === "COMMIT" || text === "ROLLBACK") admission = false;
    return query(...args);
  };
  return client;
}
