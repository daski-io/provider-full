import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ROOT,
  isPlaceholder,
  normalizedOrigin,
  redactDiagnosticMessage,
  result,
} from "./common.mjs";

const COMMON_BOOT_ENV = [
  "BASE_URL",
  "GATEWAY_BASE_URL",
  "PROVIDER_NAME",
  "MARKETPLACE_TERMS_URL",
  "MARKETPLACE_PRIVACY_URL",
  "PROVIDER_TERMS_URL",
  "PROVIDER_PRIVACY_URL",
  "DATABASE_URL",
  "BASE_RPC_URL",
  "CHAIN_ID",
  "PROVIDER_WALLET_PRIVATE_KEY",
  "IDENTITY_REGISTRY_ADDRESS",
  "SERVICE_REGISTRY_ADDRESS",
  "PROVIDER_AGENT_ID",
  "USDC_ADDRESS",
  "ADMIN_TOKEN",
  "PROVIDER_DATA_ENCRYPTION_KEY",
  "SUPPORT_EMAIL",
];

const STANDARD_RAIL_ENV = [
  "STANDARD_RAIL_GATEWAY_SIGNER",
  "STANDARD_RAIL_GATEWAY_AUDIENCE",
  "STANDARD_RAIL_GATEWAY_ORIGIN",
  "STANDARD_RAIL_PROVIDER_AUDIENCE",
  "REPUTATION_STORAGE_ADDRESS",
  "EAS_ADDRESS",
  "EAS_RUNTIME_CODE_HASH",
  "EAS_OUTCOME_SCHEMA_UID",
  "SANCTIONS_ORACLE_ADDRESS",
  "STANDARD_RAIL_PROVIDER_CONTROL_PROFILE_HASH",
  "STANDARD_RAIL_GLOBAL_POLICY_JSON",
  "STANDARD_RAIL_SERVICING_ADMISSION_JSON",
  "STANDARD_RAIL_ASSET_ACTION_CATALOG_JSON",
];

async function envFileKeys() {
  try {
    const source = await readFile(join(ROOT, ".env"), "utf8");
    return new Set(source.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      return match ? [match[1]] : [];
    }));
  } catch {
    return new Set();
  }
}

function envSource(name, fileKeys) {
  if (fileKeys.has(name)) return ".env";
  if (process.env[name] !== undefined) return "process environment";
  return "missing";
}

export function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return major === 24
    ? result("NODE_VERSION", "pass", `Node ${process.versions.node} satisfies the Node 24 contract`)
    : result(
        "NODE_VERSION",
        "fail",
        `Node ${process.versions.node} is unsupported`,
        "Install and select Node 24, then rerun doctor.",
      );
}

export async function checkRepository() {
  const required = [
    "AGENTS.md",
    "package.json",
    "src/providerServices.ts",
    "src/registerGatewayServices.ts",
    "src/core/gatewayRegistration/runtimeCatalog.ts",
    "src/core/db/migrations/001_initial.sql",
  ];
  const missing = [];
  await Promise.all(required.map(async (path) => {
    try {
      await readFile(join(ROOT, path));
    } catch {
      missing.push(path);
    }
  }));
  return missing.length === 0
    ? result("REPOSITORY_LAYOUT", "pass", "provider starter layout is present")
    : result(
        "REPOSITORY_LAYOUT",
        "fail",
        "provider starter files are missing",
        missing.sort().join(", "),
      );
}

export async function checkEnvironment(stage) {
  const fileKeys = await envFileKeys();
  const required = stage === "local"
    ? COMMON_BOOT_ENV
    : [...COMMON_BOOT_ENV, ...STANDARD_RAIL_ENV];
  const missing = required.filter((name) => !process.env[name]?.trim());
  const placeholders = required.filter((name) => isPlaceholder(process.env[name]));
  const status = stage === "local" ? "warn" : "fail";
  const issues = [
    ...missing.map((name) => `${name} (${envSource(name, fileKeys)})`),
    ...placeholders.map((name) => `${name} (placeholder in ${envSource(name, fileKeys)})`),
  ];
  if (issues.length === 0) {
    return result("ENVIRONMENT_INPUTS", "pass", "required configuration inputs are populated");
  }
  return result(
    "ENVIRONMENT_INPUTS",
    status,
    stage === "local"
      ? "full boot inputs are incomplete; offline dummy use remains available"
      : `required ${stage} inputs are incomplete`,
    issues.join("\n"),
  );
}

export async function checkServiceComposition(stage) {
  const entries = await readdir(join(ROOT, "src/services"), { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const composition = await readFile(join(ROOT, "src/providerServices.ts"), "utf8");
  const imports = [...composition.matchAll(/from\s+["']\.\/services\/([^/"']+)/g)]
    .map((match) => match[1])
    .sort();
  const missing = folders.filter((folder) => !imports.includes(folder));
  const unknown = imports.filter((folder) => !folders.includes(folder));
  if (missing.length > 0 || unknown.length > 0 || folders.length === 0) {
    return result(
      "SERVICE_COMPOSITION",
      "fail",
      "service folders and providerServices.ts do not match",
      [
        ...missing.map((name) => `unregistered: ${name}`),
        ...unknown.map((name) => `missing folder: ${name}`),
      ].join("\n"),
    );
  }
  if (stage === "mainnet" && folders.includes("dummy")) {
    return result(
      "MAINNET_DUMMY_FORBIDDEN",
      "fail",
      "the dummy reference service must be removed before Mainnet",
    );
  }
  return result(
    "SERVICE_COMPOSITION",
    "pass",
    `installed service folders: ${folders.join(", ")}`,
  );
}

export function checkStageBindings(stage) {
  if (stage === "local") {
    return result(
      "STAGE_BINDINGS",
      "pass",
      "local stage permits mock or Base Sepolia configuration",
    );
  }
  const expectedChain = stage === "testnet" ? "84532" : "8453";
  const problems = [];
  if (process.env.CHAIN_ID !== expectedChain) problems.push(`CHAIN_ID must be ${expectedChain}`);
  if (process.env.CHAIN_MODE !== "live") problems.push("CHAIN_MODE must be live");
  if (process.env.STANDARD_RAIL_ENVIRONMENT !== stage) {
    problems.push(`STANDARD_RAIL_ENVIRONMENT must be ${stage}`);
  }
  const baseOrigin = normalizedOrigin(process.env.BASE_URL);
  const gatewayOrigin = normalizedOrigin(process.env.GATEWAY_BASE_URL);
  if (!baseOrigin?.startsWith("https://")) {
    problems.push("BASE_URL must be a credential-free HTTPS URL");
  }
  if (!gatewayOrigin?.startsWith("https://")) {
    problems.push("GATEWAY_BASE_URL must be a credential-free HTTPS URL");
  }
  if (baseOrigin !== normalizedOrigin(process.env.STANDARD_RAIL_PROVIDER_AUDIENCE)) {
    problems.push("STANDARD_RAIL_PROVIDER_AUDIENCE must match the BASE_URL origin");
  }
  if (gatewayOrigin !== normalizedOrigin(process.env.STANDARD_RAIL_GATEWAY_ORIGIN)) {
    problems.push("STANDARD_RAIL_GATEWAY_ORIGIN must match the GATEWAY_BASE_URL origin");
  }
  return problems.length === 0
    ? result("STAGE_BINDINGS", "pass", `${stage} chain and signed-audience inputs agree`)
    : result(
        "STAGE_BINDINGS",
        "fail",
        `${stage} chain or audience bindings are inconsistent`,
        problems.join("\n"),
      );
}

export async function checkRuntimeConfiguration(stage) {
  try {
    await import("../../src/core/config.ts");
    return result(
      "RUNTIME_CONFIGURATION",
      "pass",
      "core configuration schema accepts the current environment",
    );
  } catch (error) {
    return result(
      "RUNTIME_CONFIGURATION",
      stage === "local" ? "warn" : "fail",
      "core configuration is not bootable",
      redactDiagnosticMessage(error),
    );
  }
}
