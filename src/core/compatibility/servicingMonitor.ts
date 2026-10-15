import { buildIdentity } from "../buildIdentity.js";
import { pool } from "../db/pool.js";
import { setRetainedServicing } from "../health.js";
import { errorExtra, logError, logInfo, logWarn } from "../logger.js";
import { getAllServices } from "../serviceRegistry/registry.js";
import { refreshCatalogHeads, type ProviderStandardRailConfig } from "../standardRail/config.js";
import type { ProviderOutcomeLaunchPolicy } from "../standardRail/launchPolicy.js";
import { signingKeyAddresses } from "../standardRail/signingKeys.js";
import {
  activationRevision,
  compatibilityReport,
  describeGap,
  type ProviderCompatibilityReportV1,
} from "./compatibilityReport.js";

/*
 * Servicing readiness for retained work. At boot, and whenever the
 * catalog's activation revision moves (another process promoted or retired
 * a version) or at least every ten minutes, the running build's capability
 * manifest and keys are checked against what durable state requires, and
 * the current heads are re-read so new sales follow the catalog. The
 * revision is a sequence, which can move before the promotion that moved it
 * commits, so the heads are re-read again on the next poll and on every
 * full check. A gap fails readiness and is logged once per change; work
 * this build cannot run is meanwhile refused before admission and never
 * claimed.
 */

const POLL_MS = 60_000;
const FULL_CHECK_MS = 10 * 60_000;

/** Check this running build against durable state and publish the readiness gate. */
export async function checkRetainedServicing(config: ProviderStandardRailConfig): Promise<ProviderCompatibilityReportV1> {
  const report = await compatibilityReport(pool, {
    gatewayOrigin: config.gatewayOrigin,
    modules: getAllServices(),
    signingKeys: signingKeyAddresses(config),
    build: buildIdentity(),
  });
  setRetainedServicing({ ok: report.ok, gaps: report.gaps.map(describeGap) });
  return report;
}

export function startServicingMonitor(
  config: ProviderStandardRailConfig,
  launchPolicy: ProviderOutcomeLaunchPolicy,
  validatedRevision: string,
): () => void {
  let revision = validatedRevision;
  let checkedAt = Date.now();
  let settling = false;
  let lastGaps = "";
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const current = await activationRevision(pool);
      const moved = current !== revision;
      if (!moved && !settling && Date.now() - checkedAt < FULL_CHECK_MS) return;
      if (config.providerControlProfileHash && await refreshCatalogHeads(config, launchPolicy)) {
        logInfo("Runtime catalog heads refreshed", { activationRevision: current });
      }
      const report = await checkRetainedServicing(config);
      settling = moved;
      revision = current;
      checkedAt = Date.now();
      const gaps = report.gaps.map(describeGap).join(",");
      if (gaps !== lastGaps) {
        if (gaps) logWarn("Retained servicing gaps", { activationRevision: current, gaps });
        else logInfo("Retained servicing compatible", { activationRevision: current });
        lastGaps = gaps;
      }
    } catch (error) {
      setRetainedServicing({ ok: false, gaps: ["check_failed"] });
      logError("Retained servicing check failed", errorExtra(error));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
