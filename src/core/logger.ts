// Single source of structured logging. Every line is one JSON object on
// stdout (stderr for error level) so log aggregators (Railway, fluentd)
// can parse without a custom transformer. Keep this module dependency-
// free — it is imported from db/pool.ts which itself runs before config
// resolution.
import { redactSensitiveText } from "./security/redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

type Extra = Record<string, unknown>;

function emit(level: LogLevel, message: string, extra?: Extra): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message: sanitizeLogValue(message),
    ...(sanitizeLogValue(extra ?? {}) as Extra),
  });
  if (level === "error") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

function sanitizeLogValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 12) return "<truncated:depth>";
  const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (/(?:password|secret|token|private_key|api_key|authorization|cookie|body|request_data|vendor_payload|signed_tx|serialized_transaction|raw_transaction|rpc_request|email|phone|address|subject|recipient|sender|first_name|middle_name|last_name|full_name|legal_name)/.test(normalizedKey)) {
    return `<redacted:${key || "sensitive"}>`;
  }
  if (typeof value === "string") return redactSensitiveText(value).slice(0, 2_000);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeLogValue(item, key, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[childKey] = sanitizeLogValue(child, childKey, depth + 1);
    }
    return out;
  }
  return value;
}

export function logInfo(message: string, extra?: Extra): void {
  emit("info", message, extra);
}

export function logWarn(message: string, extra?: Extra): void {
  emit("warn", message, extra);
}

export function logError(message: string, extra?: Extra): void {
  emit("error", message, extra);
}

// Convenience for the `extra.error` + `extra.stack` pair we use on
// caught-throw paths. Callers pass the unknown caught value; we coerce.
export function errorExtra(err: unknown, more?: Extra): Extra {
  const e = err instanceof Error ? err : new Error(String(err));
  return sanitizeLogValue({ error: e.message, stack: e.stack, ...(more ?? {}) }) as Extra;
}

// The caught value's class and a bounded message, without its stack: for
// paths that must say why something failed but log nothing of the work's
// own data. The emitted line is sanitized like every other.
// It never throws, whatever was thrown: callers use it inside catch blocks.
export function errorClassExtra(err: unknown, maxLength = 300): { errorClass: string; error: string } {
  try {
    if (!(err instanceof Error)) return { errorClass: typeof err, error: "non-error value thrown" };
    const ctor = typeof err.constructor?.name === "string" ? err.constructor.name : "";
    const name = typeof err.name === "string" ? err.name : "Error";
    const errorClass = ctor && ctor !== "Error" && ctor !== "Object" ? ctor : name;
    const message = typeof err.message === "string" ? err.message : String(err.message ?? "");
    return { errorClass, error: message.slice(0, maxLength) };
  } catch {
    return { errorClass: "unknown", error: "error could not be described" };
  }
}
