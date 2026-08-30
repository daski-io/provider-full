import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { consumeAssetEndpointRate } from "../src/core/standardRail/assetRateLimit.js";

// DATABASE_URL is pinned to a dummy by test/setup.ts for every run, so this
// test takes its live database only from DATABASE_URL_TEST (CI provides it;
// locally the gateway test container on 5433 is the documented fallback).
const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

describe("standard asset baseline against PostgreSQL", () => {
  it("admits provider-action rate buckets and rejects stored completed results", async () => {
    const schema = `provider_asset_${randomUUID().replaceAll("-", "")}`;
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE standard_asset_rate_buckets (
        scope TEXT NOT NULL,
        key_hash BYTEA NOT NULL,
        window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        request_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope,key_hash),
        CONSTRAINT standard_asset_rate_buckets_scope_check
          CHECK (scope IN ('gateway-signer','payer','provider-action','global'))
      )`);
      await client.query(`CREATE TABLE standard_asset_action_executions (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        replay_policy TEXT NOT NULL,
        result_redacted_at TIMESTAMPTZ,
        sanitized_result JSONB,
        error_class TEXT,
        CONSTRAINT standard_asset_action_result_check CHECK (
          (state='completed' AND error_class IS NULL AND
            sanitized_result IS NULL)
          OR (state='failed' AND sanitized_result IS NULL AND error_class IS NOT NULL)
          OR (state NOT IN ('completed','failed') AND sanitized_result IS NULL AND error_class IS NULL)
        )
      )`);

      await expect(consumeAssetEndpointRate({
        db: client,
        gatewaySigner: "0x1111111111111111111111111111111111111111",
        payer: "0x2222222222222222222222222222222222222222",
        actionId: "update-item",
        limits: {
          requestsPerGatewaySignerPerMinute: 10,
          requestsPerPayerPerMinute: 10,
          requestsPerActionPerMinute: 10,
          requestsGlobalPerMinute: 10,
          destructiveOutstandingPerPayer: 5,
          destructiveOutstandingPerProvider: 100,
          destructiveOutstandingGlobal: 1_000,
        },
      })).resolves.toBeUndefined();

      await expect(client.query(
        `INSERT INTO standard_asset_action_executions
          (id,state,replay_policy,sanitized_result)
         VALUES ('new-result','completed','stable-result','{"forbidden":true}')`,
      )).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("SET search_path TO public").catch(() => undefined);
      await client.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  }, 60_000);
});
