import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/*
 * Every answer about an order is signed with the keys its checkout snapshot
 * names: the gateway verifies dispatch, status and lifecycle answers against
 * the listing version's provider authority and terminal attestation keys,
 * which a version promoted by this provider binds to the agent wallet it was
 * registered under. A rotated wallet keeps serving its earlier orders only
 * while its private key stays configured here; nothing is ever re-signed
 * with a different key.
 */

export const RETAINED_SIGNING_KEYS_VARIABLE = "PROVIDER_RETAINED_WALLET_PRIVATE_KEYS";
const MAX_RETAINED_KEYS = 16;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export class SigningKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningKeyUnavailableError";
  }
}

/**
 * Parse the retained provider keys: comma-separated 32-byte private keys of
 * earlier agent wallets, distinct from each other and from the current key.
 * Failures never echo key material.
 */
export function parseRetainedSigningKeys(raw: string | undefined, current: Address): ReadonlyMap<Address, Hex> {
  const entries = (raw ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (entries.length > MAX_RETAINED_KEYS) {
    throw new Error(`${RETAINED_SIGNING_KEYS_VARIABLE} accepts at most ${MAX_RETAINED_KEYS} keys`);
  }
  const keys = new Map<Address, Hex>();
  for (const [index, entry] of entries.entries()) {
    if (!PRIVATE_KEY.test(entry) || /^0x0+$/.test(entry)) {
      throw new Error(`${RETAINED_SIGNING_KEYS_VARIABLE} entry ${index + 1} must be a non-zero 32-byte private key`);
    }
    const address = privateKeyToAccount(entry as Hex).address;
    if (address === getAddress(current)) {
      throw new Error(`${RETAINED_SIGNING_KEYS_VARIABLE} entry ${index + 1} repeats the current provider key`);
    }
    if (keys.has(address)) throw new Error(`${RETAINED_SIGNING_KEYS_VARIABLE} entry ${index + 1} is a duplicate`);
    keys.set(address, entry as Hex);
  }
  return keys;
}

export interface SigningKeySource {
  providerAuthorityPrivateKey: Hex;
  terminalAttestationPrivateKey: Hex;
  terminalAttestationKey: Address;
  retainedSigningKeys?: ReadonlyMap<Address, Hex>;
}

export interface OrderSigningKeys {
  authorityPrivateKey: Hex;
  terminalPrivateKey: Hex;
}

/**
 * The keys for answers about an order whose listing version names
 * `signingKey`. The current pair serves versions registered under the
 * current wallet; a retained wallet key signs both roles for its versions,
 * as the gateway's listing binds both roles to that one agent wallet.
 */
export function orderSigningKeys(source: SigningKeySource, signingKey: Address): OrderSigningKeys {
  const named = getAddress(signingKey);
  if (named === getAddress(source.terminalAttestationKey)) {
    return {
      authorityPrivateKey: source.providerAuthorityPrivateKey,
      terminalPrivateKey: source.terminalAttestationPrivateKey,
    };
  }
  const retained = source.retainedSigningKeys?.get(named);
  if (!retained) throw new SigningKeyUnavailableError("The order's listing names a provider key this deployment does not hold");
  return { authorityPrivateKey: retained, terminalPrivateKey: retained };
}

/** Addresses of every provider key this deployment can sign with. */
export function signingKeyAddresses(source: SigningKeySource): Set<Address> {
  return new Set([
    getAddress(source.terminalAttestationKey),
    ...[...source.retainedSigningKeys?.keys() ?? []].map((address) => getAddress(address)),
  ]);
}
