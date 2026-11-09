import { getAddress, type Address } from "viem";

/*
 * The gateway signs two kinds of material with its protocol key. Runtime
 * envelopes (quote and intake requests, quotes, dispatches, status queries,
 * lifecycle and wallet-action grants, retirement receipts) live minutes and
 * arrive over the network. Release artifacts (the global rail policy, the
 * servicing admission, the asset-action catalog, control profiles, bundles)
 * and registration artifacts (listing preparations, skill control profiles)
 * live months or years, and their hashes, signatures included, are bound
 * into splitters and admission chains, so they can never be re-signed.
 *
 * A gateway key rotation therefore needs two settings. While the gateway
 * switches keys, runtime envelopes from the previous signer stay acceptable
 * beside the current one. And artifacts already signed by an earlier key stay
 * trusted for as long as they are carried, while new ones come from a new key.
 */

export const GATEWAY_SIGNER_VARIABLE = "STANDARD_RAIL_GATEWAY_SIGNER";
export const PREVIOUS_GATEWAY_SIGNER_VARIABLE = "STANDARD_RAIL_GATEWAY_SIGNER_PREVIOUS";
export const GATEWAY_ARTIFACT_SIGNERS_VARIABLE = "STANDARD_RAIL_GATEWAY_ARTIFACT_SIGNERS";
const MAX_ARTIFACT_SIGNERS = 8;

export interface GatewaySigners {
  /** Signs the gateway's runtime envelopes now. */
  current: Address;
  /** A rotated-out runtime signer, accepted only while a rotation completes. */
  previous: Address | null;
  /** Signers whose release and registration artifacts are trusted. */
  artifacts: readonly Address[];
}

function signerAddress(raw: string, label: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw) || /^0x0{40}$/i.test(raw)) {
    throw new Error(`${label} must be a non-zero address`);
  }
  return getAddress(raw);
}

export function parseGatewaySigners(env: NodeJS.ProcessEnv): GatewaySigners {
  const rawCurrent = env[GATEWAY_SIGNER_VARIABLE]?.trim();
  if (!rawCurrent) throw new Error(`${GATEWAY_SIGNER_VARIABLE} is required for the standard rail`);
  const current = signerAddress(rawCurrent, GATEWAY_SIGNER_VARIABLE);
  const rawPrevious = env[PREVIOUS_GATEWAY_SIGNER_VARIABLE]?.trim();
  const previous = rawPrevious ? signerAddress(rawPrevious, PREVIOUS_GATEWAY_SIGNER_VARIABLE) : null;
  if (previous === current) {
    throw new Error(`${PREVIOUS_GATEWAY_SIGNER_VARIABLE} repeats ${GATEWAY_SIGNER_VARIABLE}`);
  }
  const rawArtifacts = env[GATEWAY_ARTIFACT_SIGNERS_VARIABLE]?.trim();
  if (!rawArtifacts) return { current, previous, artifacts: [current] };
  const entries = rawArtifacts.split(",").map((value) => value.trim());
  if (entries.length > MAX_ARTIFACT_SIGNERS) {
    throw new Error(`${GATEWAY_ARTIFACT_SIGNERS_VARIABLE} accepts at most ${MAX_ARTIFACT_SIGNERS} addresses`);
  }
  const artifacts: Address[] = [];
  for (const [index, entry] of entries.entries()) {
    const signer = signerAddress(entry, `${GATEWAY_ARTIFACT_SIGNERS_VARIABLE} entry ${index + 1}`);
    if (artifacts.includes(signer)) {
      throw new Error(`${GATEWAY_ARTIFACT_SIGNERS_VARIABLE} entry ${index + 1} is a duplicate`);
    }
    artifacts.push(signer);
  }
  return { current, previous, artifacts };
}

/** Runtime envelopes: the role's current signer, and the previous one during a rotation. */
export function runtimeGatewaySigners(current: Address, previous?: Address | null): readonly Address[] {
  return previous ? [current, previous] : [current];
}

/** Release artifacts: the configured artifact signers, by default the current signer. */
export function artifactGatewaySigners(signers: {
  gatewayDispatchSigner: Address;
  gatewayArtifactSigners?: readonly Address[];
}): readonly Address[] {
  return signers.gatewayArtifactSigners?.length
    ? signers.gatewayArtifactSigners
    : [signers.gatewayDispatchSigner];
}

/**
 * Registration artifacts come back from the gateway at registration time:
 * new ones carry the current runtime key, reused ones the key they were
 * prepared under.
 */
export function registrationGatewaySigners(signers: GatewaySigners): readonly Address[] {
  return [...new Set([signers.current, ...(signers.previous ? [signers.previous] : []), ...signers.artifacts])];
}

export function trustsGatewaySigner(trusted: readonly Address[], recovered: Address): boolean {
  const signer = getAddress(recovered);
  return trusted.some((address) => getAddress(address) === signer);
}
