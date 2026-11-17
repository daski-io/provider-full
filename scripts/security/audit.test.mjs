import assert from "node:assert/strict";
import { test } from "node:test";
import { advisories, exceptionProblem, judge } from "./audit-lib.mjs";

const advisory = (name, severity, ghsa = "GHSA-fc5q-39xc-vjpf") =>
  ({ name, severity, title: `${name} issue`, url: `https://github.com/advisories/${ghsa}`, source: 1 });
const report = (...entries) => ({
  vulnerabilities: Object.fromEntries(entries.map(([name, via]) => [name, { name, via }])),
});
const exception = (change = {}) => ({
  advisory: "GHSA-fc5q-39xc-vjpf", package: "picomatch", scope: "development",
  reason: "Reached only through the test and lint tools; no fixed version.", reviewed: "2026-11-17", expires: "2026-12-17", ...change,
});
const TODAY = "2026-11-18";
const clean = { vulnerabilities: {} };

test("passes a development advisory listed for its package, and fails it once expired", () => {
  const all = report(["picomatch", [advisory("picomatch", "high")]], ["vitest", ["picomatch"]]);
  assert.equal(judge({ shipped: clean, all, exceptions: [exception()], today: TODAY }).passed, true);
  assert.equal(judge({ shipped: clean, all, exceptions: [exception()], today: "2026-12-18" }).passed, false);
});

test("never excepts what the runtime ships", () => {
  const shipped = report(["picomatch", [advisory("picomatch", "high")]]);
  assert.equal(judge({ shipped, all: shipped, exceptions: [exception()], today: TODAY }).passed, false);
});

test("keeps each package of one advisory apart: another package of the same advisory is not excepted", () => {
  const all = report(["picomatch", [advisory("picomatch", "high")]], ["evil-dev-tool", [advisory("evil-dev-tool", "critical")]]);
  assert.equal(advisories(all).length, 2);
  const verdict = judge({ shipped: clean, all, exceptions: [exception()], today: TODAY });
  assert.equal(verdict.passed, false);
  assert.ok(verdict.lines.some((line) => line.includes("evil-dev-tool")));
});

test("fails an unlisted advisory, and ignores findings below moderate", () => {
  const unlisted = report(["tinyglobby", [advisory("tinyglobby", "moderate", "GHSA-aaaa-bbbb-cccc")]]);
  assert.equal(judge({ shipped: clean, all: unlisted, exceptions: [exception()], today: TODAY }).passed, false);
  const low = report(["tinyglobby", [advisory("tinyglobby", "low", "GHSA-aaaa-bbbb-cccc")]]);
  assert.equal(judge({ shipped: clean, all: low, exceptions: [], today: TODAY }).passed, true);
});

test("refuses an exception that is malformed, permanent or reviewed in the future", () => {
  for (const [label, change] of [
    ["impossible dates", { reviewed: "0000-00-00", expires: "9999-99-99" }],
    ["a far expiry", { expires: "2027-11-17" }],
    ["an expiry before its review", { expires: "2026-11-01" }],
    ["a future review", { reviewed: "2026-12-01", expires: "2026-12-20" }],
    ["another scope", { scope: "runtime" }],
    ["no reason", { reason: "" }],
  ]) {
    assert.notEqual(exceptionProblem(exception(change), TODAY), null, label);
    const all = report(["picomatch", [advisory("picomatch", "high")]]);
    assert.equal(judge({ shipped: clean, all, exceptions: [exception(change)], today: TODAY }).passed, false, label);
  }
  assert.equal(exceptionProblem(exception(), TODAY), null);
});
