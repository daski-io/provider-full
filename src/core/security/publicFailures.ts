const PUBLIC_FAILURE_MESSAGES = {
  supplier: "The supplier is temporarily unavailable. Please retry later.",
  chain: "The chain service is temporarily unavailable. Please retry later.",
  supplierRetrying:
    "The supplier is temporarily unavailable. No action is needed; processing will retry.",
  supplierCorrection:
    "The supplier could not accept the correction. Review the requested fields and resend.",
  document:
    "The document is not currently available. Contact support if the issue persists.",
  fulfillment:
    "Fulfillment could not be completed. Contact support if the issue persists.",
} as const;

export type PublicFailureKind = keyof typeof PUBLIC_FAILURE_MESSAGES;

/**
 * Returns a fixed customer/model-safe dependency failure. Supplier and RPC
 * exception text is intentionally not accepted by this boundary.
 */
export function publicFailureMessage(kind: PublicFailureKind): string {
  return PUBLIC_FAILURE_MESSAGES[kind];
}
