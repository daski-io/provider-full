import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from "viem";

function assertValidUnicode(input: string): void {
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("Canonical JSON contains invalid Unicode");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("Canonical JSON contains invalid Unicode");
    }
  }
}

// Backstop for values hashed before request validation runs (for example the
// quote path hashes the raw request first): recursion depth is capped and
// keys aliasing Object.prototype members are rejected.
const CANONICAL_MAX_DEPTH = 64;
const UNSAFE_CANONICAL_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function value(input: unknown, depth: number): string {
  if (depth > CANONICAL_MAX_DEPTH) throw new Error("Canonical JSON is too deeply nested");
  if (input === null) return "null";
  if (typeof input === "string") {
    assertValidUnicode(input);
    return JSON.stringify(input);
  }
  if (typeof input === "boolean") return JSON.stringify(input);
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("Noncanonical number");
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map((item) => value(item, depth + 1)).join(",")}]`;
  }
  if (!input || typeof input !== "object") throw new Error("Unsupported canonical value");
  const object = input as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => {
    assertValidUnicode(key);
    if (UNSAFE_CANONICAL_KEYS.has(key)) throw new Error("Canonical JSON contains an unsafe key");
    if (object[key] === undefined) throw new Error("Undefined canonical value");
    return `${JSON.stringify(key)}:${value(object[key], depth + 1)}`;
  }).join(",")}}`;
}

export const canonicalJson = (input: unknown): string => value(input, 1);
export const canonicalHash = (input: unknown): Hex => keccak256(stringToHex(value(input, 1)));

export function recipeNonce(input: {
  chainId: number;
  canonicalToken: Address;
  payer: Address;
  splitter: Address;
  grossAmount: bigint;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  quoteHash: Hex;
  canonicalRequestHash: Hex;
  orderNonce: Hex;
}): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint256" }, { type: "address" },
      { type: "address" }, { type: "address" }, { type: "uint256" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" },
    ],
    [
      keccak256(stringToHex("DaskiStandardExactOrderV1")), BigInt(input.chainId),
      input.canonicalToken, input.payer, input.splitter, input.grossAmount,
      input.listingManifestHash, input.providerOfferHash, input.quoteHash,
      input.canonicalRequestHash, input.orderNonce,
    ],
  ));
}

/**
 * V2 order binding for dynamic-catalog listings: identical slot layout to
 * V1 with the listing manifest hash replaced by the runtime listing
 * commitment hash and the provider offer hash replaced by the provider
 * intent hash. Verifiers must additionally check the intent hash equals the
 * one embedded in the runtime commitment.
 */
export function recipeNonceV2(input: {
  chainId: number;
  canonicalToken: Address;
  payer: Address;
  splitter: Address;
  grossAmount: bigint;
  runtimeCommitmentHash: Hex;
  providerIntentHash: Hex;
  quoteHash: Hex;
  canonicalRequestHash: Hex;
  orderNonce: Hex;
}): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint256" }, { type: "address" },
      { type: "address" }, { type: "address" }, { type: "uint256" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" },
    ],
    [
      keccak256(stringToHex("DaskiStandardExactOrderV2")), BigInt(input.chainId),
      input.canonicalToken, input.payer, input.splitter, input.grossAmount,
      input.runtimeCommitmentHash, input.providerIntentHash, input.quoteHash,
      input.canonicalRequestHash, input.orderNonce,
    ],
  ));
}

export function assertExactKeys(value: unknown, expected: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

export const SIGNED_ENVELOPE_KEYS = [
  "artifactType", "schemaVersion", "environment", "chainId", "audience", "signerKeyId",
  "issuedAt", "validBefore", "payload", "signature",
] as const;

export function assertNoDuplicateJsonKeys(text: string): void {
  let offset = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? "")) offset += 1; };
  const stringToken = (): string => {
    const start = offset;
    if (text[offset] !== '"') throw new Error("JSON string expected");
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") { offset += 2; continue; }
      if (text[offset] === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset)) as string;
      }
      offset += 1;
    }
    throw new Error("Unterminated JSON string");
  };
  const parseValue = (): void => {
    whitespace();
    if (text[offset] === '"') { stringToken(); return; }
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") { offset += 1; return; }
      while (true) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) throw new Error(`Duplicate JSON key ${key}`);
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") throw new Error("JSON colon expected");
        offset += 1;
        parseValue();
        whitespace();
        if (text[offset] === "}") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error("JSON comma expected");
        offset += 1;
      }
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") { offset += 1; return; }
      while (true) {
        parseValue();
        whitespace();
        if (text[offset] === "]") { offset += 1; return; }
        if (text[offset] !== ",") throw new Error("JSON comma expected");
        offset += 1;
      }
    }
    const token = text.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw new Error("Invalid JSON token");
    offset += token.length;
  };
  parseValue();
  whitespace();
  if (offset !== text.length) throw new Error("Trailing JSON content");
}

export function unsignedEnvelopeHash(envelope: Record<string, unknown>): Hex {
  const { signature: _signature, ...unsigned } = envelope;
  return canonicalHash(unsigned);
}
