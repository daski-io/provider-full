#!/usr/bin/env node
// The dependency audit CI runs (npm run security:audit).
//
//  1. What the runtime ships (npm audit --omit=dev): any advisory of moderate
//     or higher severity fails. No exception applies here, ever.
//  2. Every dependency, the test and lint tools included: any advisory of
//     moderate or higher severity fails, unless it is listed in
//     audit-exceptions.json for the development scope and that package, with
//     a reason, the date it was reviewed and the date it expires, at most 31
//     days after the review. An expired exception fails again, so each one is
//     reviewed before it is renewed.
//
// An exception is for an advisory with no fixed version that only the
// development tools reach. Exit 0 passes; 1 is a finding; 2 the audit could
// not run.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { judge } from "./audit-lib.mjs";

function audit(args) {
  let out;
  try {
    // Every dependency is installed for the audit whatever the environment says, and the registry is asked.
    out = execFileSync("npm", ["audit", "--json", "--offline=false", ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "development", npm_config_omit: "" },
    });
  } catch (error) {
    // npm audit exits 1 when it finds anything; its JSON is still on stdout.
    out = error.stdout;
  }
  let report;
  try {
    report = JSON.parse(out);
  } catch {
    console.error("npm audit gave no report: the audit endpoint may be unavailable");
    process.exit(2);
  }
  if (report.error) {
    console.error(`npm audit failed: ${[report.error.code, report.error.summary, report.message].filter(Boolean).join(" ") || "unknown error"}`);
    process.exit(2);
  }
  return report;
}

{
  const exceptions = JSON.parse(readFileSync(new URL("./audit-exceptions.json", import.meta.url), "utf8")).exceptions;
  if (!Array.isArray(exceptions)) {
    console.error("audit-exceptions.json needs an exceptions list");
    process.exit(1);
  }
  const verdict = judge({
    shipped: audit(["--omit=dev"]),
    all: audit(["--include=dev"]),
    exceptions,
    today: new Date().toISOString().slice(0, 10),
  });
  for (const line of verdict.lines) (verdict.passed ? console.log : console.error)(line);
  if (!verdict.passed) process.exit(1);
  console.log("dependency audit passed");
}
