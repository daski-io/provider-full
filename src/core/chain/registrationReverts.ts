// The ServiceRegistry refuses a duplicate id with the revert reason below.
// viem surfaces it from gas estimation as an ExecutionRevertedError (or a
// ContractFunctionRevertedError when the ABI decodes it) somewhere in the
// cause chain of the error that prepareTransactionRequest throws.
const SERVICE_ALREADY_REGISTERED = /service already registered/i;
const MAX_CAUSE_DEPTH = 12;

function textFields(error: unknown): string[] {
  if (!error || typeof error !== "object") return typeof error === "string" ? [error] : [];
  const record = error as Record<string, unknown>;
  return ["message", "shortMessage", "details", "reason"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string");
}

/**
 * True when the broadcast failed because the registry already holds the id:
 * the finalized-depth `exists` read that preceded it could not see a
 * registration mined fewer than CHAIN_WRITE_FINALITY_CONFIRMATIONS blocks
 * earlier, while gas estimation runs against the latest state.
 */
export function isServiceAlreadyRegisteredRevert(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    if (textFields(current).some((text) => SERVICE_ALREADY_REGISTERED.test(text))) {
      return true;
    }
    current = typeof current === "object"
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return false;
}
