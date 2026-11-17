// The judgement of the dependency audit (scripts/security/audit.mjs runs
// it): which findings fail, and which development-only advisories a listed,
// dated exception lets through. No I/O here, so the tests import it.

const LEVELS = ["info", "low", "moderate", "high", "critical"];
const AT_LEAST = LEVELS.indexOf("moderate");
export const MAX_EXCEPTION_DAYS = 31;
const DAY_MS = 86_400_000;

/** A date of the form YYYY-MM-DD that names a real day, as its time at midnight UTC; null otherwise. */
export function realDate(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== text ? null : time;
}

/** Why an exception cannot be used, or null: the development scope, a reason, a real review date not after today, an expiry within the bound. */
export function exceptionProblem(exception, today) {
  if (typeof exception !== "object" || exception === null) return "is not an object";
  if (exception.scope !== "development") return 'needs scope "development"';
  if (typeof exception.advisory !== "string" || typeof exception.package !== "string") return "needs an advisory and a package";
  if (typeof exception.reason !== "string" || exception.reason.trim().length < 20) return "needs a reason";
  const reviewed = realDate(exception.reviewed);
  const expires = realDate(exception.expires);
  if (reviewed === null || expires === null) return "needs real reviewed and expires dates";
  if (reviewed > realDate(today)) return "is reviewed in the future";
  if (expires < reviewed || expires - reviewed > MAX_EXCEPTION_DAYS * DAY_MS) {
    return `expires more than ${MAX_EXCEPTION_DAYS} days after its review`;
  }
  return null;
}

/** Each advisory and package behind a report's findings at or above moderate. */
export function advisories(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      if (LEVELS.indexOf(via.severity) < AT_LEAST) continue;
      const id = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/.exec(String(via.url ?? ""))?.[0] ?? String(via.source ?? via.title);
      const name = String(via.name ?? vulnerability.name);
      found.set(`${id}\n${name}`, { id, package: name, severity: via.severity, title: String(via.title ?? "") });
    }
  }
  return [...found.values()];
}

/** The lines of the verdict and whether it passes, from the two reports, the exceptions and today's date. */
export function judge({ shipped, all, exceptions, today }) {
  const lines = [];
  let failed = false;
  for (const exception of exceptions) {
    const problem = exceptionProblem(exception, today);
    if (problem) {
      lines.push(`audit exception ${exception?.advisory ?? "?"} ${problem}`);
      failed = true;
    }
  }
  const runtime = advisories(shipped);
  for (const advisory of runtime) {
    lines.push(`runtime dependency: ${advisory.id} ${advisory.package} (${advisory.severity}): ${advisory.title}`);
    failed = true;
  }
  for (const advisory of advisories(all)) {
    if (runtime.some((item) => item.id === advisory.id && item.package === advisory.package)) continue;
    const exception = exceptions.find((item) => exceptionProblem(item, today) === null
      && item.advisory === advisory.id && item.package === advisory.package);
    if (exception && realDate(exception.expires) >= realDate(today)) {
      lines.push(`development dependency, excepted until ${exception.expires}: ${advisory.id} ${advisory.package} (${advisory.severity})`);
      continue;
    }
    const expired = exceptions.find((item) => item?.advisory === advisory.id && item?.package === advisory.package);
    lines.push(`${expired ? `expired or unusable exception (${expired.expires}): ` : ""}development dependency: ${advisory.id} ${advisory.package} (${advisory.severity}): ${advisory.title}`);
    failed = true;
  }
  return { passed: !failed, lines };
}
