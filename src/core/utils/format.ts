// USDC has 6 decimals on Base. All money values inside the provider are
// signed bigints in atomic units (positive = settlement, negative =
// refund). This formatter is the single source of truth for surfacing
// those values in HTML, LLM prompts, and event payloads — keeping it in
// one place ensures the wire string (`-$12.50`) is consistent.

/// USD number → USDC atomic units via fixed-point string math (no IEEE-754
/// drift). Generic money conversion lives in core so sibling services never
/// need to import each other.
export function usdToUsdcAtomic(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`invalid USD price: ${usd}`);
  }
  const fixed = usd.toFixed(6);
  const [whole, frac] = fixed.split(".");
  const wholePart = BigInt(whole) * 1_000_000n;
  const fracPart = BigInt(frac ?? "0");
  return wholePart + fracPart;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatUsdDecimal(decimal: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(decimal);
  if (!match) throw new Error("invalid USD decimal");
  const [, sign, whole, fraction = ""] = match;
  return `${sign}$${groupThousands(whole)}${fraction}`;
}

export function formatUsdc(atomic: bigint): string {
  const sign = atomic < 0n ? "-" : "";
  const abs = atomic < 0n ? -atomic : atomic;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return formatUsdDecimal(`${sign}${whole.toString()}.${frac}`);
}

// Relative time string ("3m ago", "2h ago", "5d ago"). Used by admin UI
// list pages where a precise timestamp is overkill. Anything older than
// 30 days falls back to an absolute YYYY-MM-DD slice so the operator
// doesn't have to mentally subtract weeks.
export function timeAgo(d: Date, now: Date = new Date()): string {
  const diffSec = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 30) return `${diffD}d ago`;
  return d.toISOString().slice(0, 10);
}

// Shorten a 0x-prefixed wallet/hash for display. Hex-only — falls back to
// the raw input when the prefix is missing so we don't silently truncate
// arbitrary identifiers.
export function shortHex(s: string, lead = 6, tail = 4): string {
  if (!s.startsWith("0x") || s.length <= lead + tail + 1) return s;
  return `${s.slice(0, lead)}…${s.slice(-tail)}`;
}
