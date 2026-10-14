// How the provider identity helper sends transactions: each one signed at a
// single nonce, retried only as that same transaction, and recorded so a
// stop can name what this run already sent.

/** A deliberate stop with the process exit code main() should use. */
export class RegistrationAbort extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "RegistrationAbort";
    this.exitCode = exitCode;
  }
}

/**
 * `pub`/`wallet` are viem clients (or stubs) and `account` the provider
 * account; `log` receives one JSON-able entry per event and `sleep` paces
 * the lag retry.
 */
export function createTransactions({ pub, wallet, account, log, sleep }) {
  // Public Base RPCs can serve stale reads (and thus stale gas-estimation
  // state) right after a write — retry calls that depend on the previous
  // transaction's state.
  async function retryOnLag(label, fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= 4) throw err;
        log({ step: "retry", label, attempt: attempt + 1 });
        await sleep(3000);
      }
    }
  }

  // Labels of every transaction this run handed to the network.
  const sent = [];
  const sentSummary = () =>
    sent.length === 0 ? "Nothing was sent." : `This run already sent: ${sent.join(", ")}.`;

  // Every transaction is signed at one nonce, read once before the first
  // attempt. A retry after a send whose answer was lost can then only repeat
  // that transaction, never sign a second one at the next nonce (a second
  // mint, a second listing fee). When the retries are refused and the nonce
  // has been used, the first send may have reached the network: the run
  // stops, and a re-run skips every step already on chain.
  async function sendTx(label, params) {
    const nonce = params.nonce ?? await retryOnLag(`${label}.nonce`, () =>
      pub.getTransactionCount({ address: account.address, blockTag: "pending" }));
    let hash;
    try {
      hash = await retryOnLag(label, () => wallet.writeContract({ ...params, nonce }));
    } catch (err) {
      const pendingNonce = await pub
        .getTransactionCount({ address: account.address, blockTag: "pending" })
        .catch(() => undefined);
      if (pendingNonce !== undefined && pendingNonce > nonce) {
        throw new RegistrationAbort(
          `${label} may already have been sent at nonce ${nonce}, but its send was not confirmed. ` +
          "Wait until the wallet's pending transactions are mined, then re-run; steps already on chain are skipped. " +
          (sent.length === 0 ? "Nothing was sent before it." : `Sent before it: ${sent.join(", ")}.`),
          2,
        );
      }
      throw err;
    }
    sent.push(label);
    log({ step: `${label}.sent`, hash });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    log({ step: `${label}.receipt`, status: receipt.status, blockNumber: receipt.blockNumber.toString() });
    if (receipt.status !== "success") throw new RegistrationAbort(`${label} reverted`, 2);
    return receipt;
  }

  return { retryOnLag, sendTx, sentSummary };
}
