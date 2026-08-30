// The dummy service is a compiled, tested reference implementation of
// the ServiceModule contract — the starting point for building a real
// service (docs/adding-a-service.md).

export const DUMMY_SLUG = "dummy";
export const NOTE_ASSET_TYPE = "note";

/// Retail price of create-note in atomic USDC (6 decimals): $0.10.
export const NOTE_PRICE_ATOMIC = "100000";

export function assertDummyServiceAllowed(chainId: number): void {
  if (chainId === 8453) {
    throw new Error("Replace the dummy service before deploying on Base mainnet");
  }
}
