/** Synchronize one installed skill's reviewed pre-execute defaults. */
import pg from "pg";
import type { PreExecuteAgentConfig } from "../src/core/serviceRegistry/extensionTypes.js";
import { providerServices } from "../src/providerServices.js";
import {
  assertVerifiedTlsForDatabaseMutation,
  databaseTlsConfig,
  parseDatabaseSslMode,
} from "../src/core/db/tls.js";
import { RUNTIME_EPOCH_STATEMENT } from "../src/core/db/runtimeEpoch.js";

const preExecuteAgent: Record<string, PreExecuteAgentConfig> = {};
for (const service of providerServices) {
  for (const [skillId, defaults] of Object.entries(
    service.fulfillment.preExecuteAgent ?? {},
  )) {
    if (preExecuteAgent[skillId]) {
      throw new Error(`Duplicate pre-execute skill id: ${skillId}`);
    }
    preExecuteAgent[skillId] = defaults;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const includeModel = args.includes("--include-model");
  const skillId = args.find((arg) => !arg.startsWith("--"));
  const defaults = skillId ? preExecuteAgent[skillId] : undefined;
  if (!skillId || !defaults) {
    console.error(
      "usage: sync-preexecute-llm-config.ts <skillId> [--include-model]\n" +
        `known: ${Object.keys(preExecuteAgent).join(", ")}`,
    );
    process.exit(2);
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL env var required");
  const sslMode = parseDatabaseSslMode(process.env.DATABASE_SSL_MODE);
  assertVerifiedTlsForDatabaseMutation(url, sslMode);
  const client = new pg.Client({
    connectionString: url,
    ssl: databaseTlsConfig(sslMode, process.env.DATABASE_CA_CERT),
  });
  await client.connect();
  try {
    await client.query(RUNTIME_EPOCH_STATEMENT);
    const promptSql = `jsonb_set(
      jsonb_set(COALESCE(config, '{}'::jsonb),
        '{llm,default_system_prompt}', to_jsonb($2::text), true),
      '{llm,default_escalation_rules}', to_jsonb($3::text), true)`;
    const fullSql = includeModel
      ? `jsonb_set(jsonb_set(${promptSql},
          '{llm,model}', to_jsonb($4::text), true),
          '{llm,timeout_ms}', to_jsonb($5::int), true)`
      : promptSql;
    const params: unknown[] = [
      skillId, defaults.systemPrompt, defaults.escalationRules,
    ];
    if (includeModel) params.push(defaults.model, defaults.timeoutMs);
    const result = await client.query(
      `UPDATE skills SET config = ${fullSql} WHERE skill_id = $1 RETURNING skill_id`,
      params,
    );
    console.log(`updated ${result.rowCount} skills row(s) for '${skillId}'`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("sync failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
