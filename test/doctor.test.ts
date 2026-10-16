import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runDoctor(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    ["--import=tsx", "scripts/doctor.mjs", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 15_000,
    },
  );
}

function runDoctorThroughNpm(args: string[], env: NodeJS.ProcessEnv = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("doctor npm-path test must be launched through npm");
  }
  return spawnSync(
    process.execPath,
    [npmCli, "run", "--silent", "doctor", "--", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 15_000,
    },
  );
}

describe("provider doctor", () => {
  it("documents its read-only boundary without loading runtime configuration", () => {
    const run = runDoctor(["--help"]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Daski provider doctor (read-only)");
    expect(run.stdout).toContain("SELECT-only queries");
    expect(run.stderr).toBe("");
  });

  it("fails closed for Mainnet, reports external whitelisting, and redacts URL secrets", () => {
    const urlSecret = "doctor-rpc-secret-value";
    const run = runDoctorThroughNpm(["--stage=mainnet", "--json"], {
      DATABASE_URL: "",
      CHAIN_ID: "8453",
      CHAIN_MODE: "live",
      STANDARD_RAIL_ENVIRONMENT: "mainnet",
      BASE_URL: "https://provider.example.invalid",
      GATEWAY_BASE_URL: "https://gateway.example.invalid",
      BASE_RPC_URL: `https://rpc.example.invalid/${urlSecret}`,
    });

    expect(run.status).toBe(1);
    const report = JSON.parse(run.stdout) as {
      ok: boolean;
      stage: string;
      checks: Array<{ code: string; status: string }>;
    };
    const codes = new Map(report.checks.map((check) => [check.code, check.status]));
    expect(report.ok).toBe(false);
    expect(report.stage).toBe("mainnet");
    expect(codes.get("REPOSITORY_LAYOUT")).toBe("pass");
    expect(codes.get("MAINNET_DUMMY_FORBIDDEN")).toBe("fail");
    expect(codes.get("MAINNET_WHITELIST_REQUIRED")).toBe("warn");
    expect(codes.get("DATABASE_REACHABLE")).toBe("fail");
    expect(`${run.stdout}${run.stderr}`).not.toContain(urlSecret);
  });

  it("rejects unknown options without a stack trace", () => {
    const run = runDoctor(["--mutate"]);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown doctor option");
    expect(run.stderr).not.toContain(" at ");
  });
});
