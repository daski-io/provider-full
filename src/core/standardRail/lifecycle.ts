import { revealFrozenTaskProjection } from "../a2a/responseBuilder.js";
import { pool } from "../db/pool.js";
import { getServiceById } from "../db/queries/services.js";
import { serviceDeclaresOutage } from "../serviceRegistry/readiness.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { authenticateLifecycleCall, type LifecycleCall } from "./lifecycleAuthorization.js";
import type { ContractIntegrityCheck } from "./contractIntegrity.js";
import { artifactUnavailable, lifecycleUnavailable } from "./lifecycleErrors.js";
import { applyLifecycleInput } from "./lifecycleInput.js";
import { applyLifecycleCancel } from "./lifecycleMutations.js";
import { readLifecycleState, signedLifecycleAnswer, type LifecycleAnswerV1 } from "./lifecycleResponse.js";
import { consumeLifecycleNonce, loadLifecycleTask, type StandardTaskRow } from "./lifecycleStore.js";
import { acceptSupportRequest } from "./orderSupport.js";
import { loadFrozenTerminalProjection } from "./terminalResult.js";

/**
 * Buyer order actions the gateway proxies to the provider's lifecycle URL.
 * Every call is authenticated before any state is read (the gateway grant
 * first, then a read capability or the payer's own signature), and every
 * answer is a fresh signed observation: the public state, operations, and
 * the lifecycle attestation of the frozen terminal identity once terminal.
 *
 * Status never carries a result. Artifact carries the frozen projection of a
 * completed order: unrevealed under a read capability, with its protected
 * references revealed under the payer's fresh signature. Support answers its
 * durable receipt. Every failure is a named refusal (lifecycleErrors.ts).
 */
export class StandardLifecycleService {
  constructor(
    private readonly config: ProviderStandardRailConfig,
    private readonly chainId: number,
    /** The fresh rail-contract proof a mutation takes first (contractIntegrity.ts). */
    private readonly contractIntegrity?: ContractIntegrityCheck,
  ) {}

  async perform(body: unknown): Promise<LifecycleAnswerV1> {
    const call = await authenticateLifecycleCall(this.config, this.chainId, body);
    const task = await loadLifecycleTask(call);
    // A mutation proves the rail contracts before its nonce is consumed, so
    // a failed proof leaves the buyer's authorization usable for a retry.
    if ((call.action === "input" || call.action === "cancel") && this.contractIntegrity) {
      await this.contractIntegrity().catch(() => {
        throw lifecycleUnavailable("The rail contracts could not be verified");
      });
    }
    // Input waits out an outage its service declares, also before the nonce:
    // the service could answer it with a failure the order need not take.
    // Cancellation, which cannot fail the order, still answers.
    if (call.action === "input" && await this.declaresOutage(task)) {
      throw lifecycleUnavailable("The service declares an outage");
    }
    await consumeLifecycleNonce(task, call);
    const order = { orderId: task.standard_order_id, taskId: task.id };
    switch (call.action) {
      case "status":
        return signedLifecycleAnswer(this.config, order);
      case "artifact":
        return signedLifecycleAnswer(this.config, order, { result: await this.artifactResult(task, call) });
      case "support": {
        const supportReceipt = await acceptSupportRequest(this.config, task, call);
        return signedLifecycleAnswer(this.config, order, { result: { supportReceipt } });
      }
      case "input":
        await applyLifecycleInput(this.config, task, call, () => this.publicState(task));
        return signedLifecycleAnswer(this.config, order, { result: await this.completionResult(task) });
      case "cancel":
        await applyLifecycleCancel(this.config, task, call, () => this.publicState(task));
        return signedLifecycleAnswer(this.config, order);
    }
  }

  private async declaresOutage(task: StandardTaskRow): Promise<boolean> {
    const service = await getServiceById(task.service_id);
    return service !== null && await serviceDeclaresOutage(service.slug);
  }

  private async publicState(task: StandardTaskRow): Promise<string> {
    return (await readLifecycleState(this.config, { orderId: task.standard_order_id, taskId: task.id })).state;
  }

  /** The frozen projection of a completed order, revealed only for the payer's own signature. */
  private async artifactResult(task: StandardTaskRow, call: LifecycleCall): Promise<unknown> {
    if (await this.publicState(task) !== "completed") {
      throw artifactUnavailable("Artifacts are available only after completed fulfilment");
    }
    const frozen = await loadFrozenTerminalProjection(pool, task.id);
    if (!frozen) throw artifactUnavailable("The order's deliverable bytes are not retained");
    return call.authorization.form === "payer-signed"
      ? revealFrozenTaskProjection(task.id, frozen.projection, frozen.references)
      : frozen.projection;
  }

  /// A completion answered inline carries the frozen unrevealed projection,
  /// whose hash the attestation signs.
  private async completionResult(task: StandardTaskRow): Promise<unknown> {
    if (await this.publicState(task) !== "completed") return undefined;
    return (await loadFrozenTerminalProjection(pool, task.id))?.projection;
  }
}
