import { emitEvent, type EmitEventArgs } from "../events/emitter.js";
import {
  describeOutboundFailure,
  onOutboundFailure,
  type OutboundFailureReport,
} from "./outboundFailures.js";

/// The platform-log row for one reported outbound failure. Client-side
/// rejections (4xx) are warnings; outages, timeouts, and 5xx are errors.
export function outboundFailureEvent(report: OutboundFailureReport): EmitEventArgs {
  const clientRejection = report.reason === "http_error"
    && report.status !== null
    && report.status < 500;
  return {
    source: "system",
    severity: clientRejection ? "warn" : "error",
    type: "outbound.request_failed",
    message:
      `Outbound ${report.operation} to ${report.target} failed: ` +
      `${describeOutboundFailure(report)}.` +
      (report.suppressed > 0 ? ` ${report.suppressed} identical failure(s) since the previous report.` : ""),
    payload: {
      target: report.target,
      operation: report.operation,
      reason: report.reason,
      status: report.status,
      code: report.code,
      networkCode: report.networkCode,
      suppressed: report.suppressed,
    },
  };
}

/// Installed once at boot so every transport's failures reach the admin
/// Platform Log. Returns the uninstall function.
export function installOutboundFailureLog(): () => void {
  return onOutboundFailure((report) => emitEvent(outboundFailureEvent(report)).then(() => undefined));
}
