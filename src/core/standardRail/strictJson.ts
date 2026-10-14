import { UNSAFE_JSON_KEYS } from "./jsonBounds.js";

/**
 * Parse-boundary belt limits for every standard-rail request body. They mirror
 * the gateway's own scanner (depth, value count, key length and unsafe keys);
 * the semantic budgets in jsonBounds.ts stay stricter. These only stop
 * pathological documents before any handler hashes or validates them.
 */
export const STRICT_JSON_SCAN_LIMITS = {
  maxDepth: 64,
  maxNodes: 262_144,
  maxKeyLength: 256,
} as const;

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrictJsonError";
  }
}

/**
 * Decode request bytes as strict UTF-8 and reject duplicate, unsafe or
 * oversized keys. A lenient decoder would replace invalid sequences and make
 * the parsed value differ from the bytes the gateway signed and hashed.
 */
export function decodeStrictJson(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StrictJsonError("JSON is not valid UTF-8");
  }
  assertStrictJsonText(text);
  return text;
}

export function assertStrictJsonText(text: string): void {
  let offset = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/[ \t\n\r]/.test(text[offset] ?? "")) offset += 1;
  };
  const stringToken = (): string => {
    const start = offset;
    if (text[offset] !== '"') throw new StrictJsonError("JSON string expected");
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (text[offset] === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset)) as string;
      }
      offset += 1;
    }
    throw new StrictJsonError("Unterminated JSON string");
  };
  const value = (depth: number): void => {
    nodes += 1;
    if (depth > STRICT_JSON_SCAN_LIMITS.maxDepth) throw new StrictJsonError("JSON is too deeply nested");
    if (nodes > STRICT_JSON_SCAN_LIMITS.maxNodes) throw new StrictJsonError("JSON contains too many values");
    whitespace();
    if (text[offset] === '"') {
      stringToken();
      return;
    }
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = stringToken();
        if (key.length > STRICT_JSON_SCAN_LIMITS.maxKeyLength) {
          throw new StrictJsonError("JSON key is too long");
        }
        if (UNSAFE_JSON_KEYS.has(key)) throw new StrictJsonError("JSON contains an unsafe key");
        if (keys.has(key)) throw new StrictJsonError("JSON contains a duplicate key");
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") throw new StrictJsonError("JSON colon expected");
        offset += 1;
        value(depth + 1);
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new StrictJsonError("JSON comma expected");
        offset += 1;
      }
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new StrictJsonError("JSON comma expected");
        offset += 1;
      }
    }
    const token = text.slice(offset, offset + 512)
      .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw new StrictJsonError("Invalid JSON token");
    offset += token.length;
  };
  value(1);
  whitespace();
  if (offset !== text.length) throw new StrictJsonError("Trailing JSON content");
}
