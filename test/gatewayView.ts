import type { Hex } from "viem";
import { canonicalHash } from "../src/core/standardRail/canonical.js";
import { acceptDispatchResponse, semanticOperationsHash } from "./gatewayConsumer.js";
import {
  judgeLifecycleAnswer,
  nextObservation,
  readBoundedAnswer,
  type GatewayObservation,
} from "./gatewayLifecycleConsumer.js";
import { context, keys, type WireAnswer } from "./providerWireFixture.js";

const pathOf = (url: string): string => new URL(url).pathname;
const profile = context.provider.controlProfile;
const LIFECYCLE = pathOf(profile.lifecycleUrl);
const DISPATCH = pathOf(profile.dispatchUrl);
const STATUS = pathOf(profile.dispatchStatusUrl);
const KEYS = {
  providerAuthorityKey: keys.providerAuthority!.address as Hex,
  terminalAttestationKey: keys.providerTerminalAttestation!.address as Hex,
};

const record = (value: unknown): Record<string, any> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;

/** A provider answer the gateway would refuse to accept or to name. */
export class ProviderWireDefect extends Error {}

/**
 * The gateway's stored view of every order a wire test touches. Each provider
 * answer is judged as the gateway judges it and, when accepted, becomes the
 * stored observation the next answer is judged against, so the original
 * terminal identity is enforced across dispatch, status and lifecycle
 * answers. A 2xx lifecycle answer the gateway would reject, a 409 or 503
 * lifecycle refusal it would not name, and a dispatch or status answer that
 * equivocates on its revision or original terminal are provider defects. A
 * dispatch answer the gateway would reject is ambiguous and changes nothing.
 */
export function createGatewayView() {
  const orders = new Map<string, GatewayObservation>();
  return {
    reset(): void {
      orders.clear();
    },
    async observe(url: string, body: unknown, answer: WireAnswer): Promise<void> {
      const request = record(body);
      if (!request) return;
      const now = Math.floor(Date.now() / 1_000);
      const route = pathOf(url);
      if (route === LIFECYCLE) {
        const orderId = String(request.orderId);
        const verdict = await judgeLifecycleAnswer(answer, {
          ...KEYS,
          action: String(request.action),
          request: record(request.request) ?? {},
          readCapability: record(request.authorization)?.type === "DaskiReadCap",
          orderId,
          providerTaskId: String(request.providerTaskId),
          maxResponseBytes: profile.maxResponseBytes,
          receivedAt: now,
          stored: orders.get(orderId) ?? null,
        });
        if (verdict.verdict === "accepted") orders.set(orderId, verdict.stored);
        const ok = answer.status >= 200 && answer.status <= 299;
        if ((ok && verdict.verdict !== "accepted") ||
            ((answer.status === 409 || answer.status === 503) && verdict.verdict !== "refused")) {
          throw new ProviderWireDefect(`gateway verdict on a ${request.action} answer: ${JSON.stringify(verdict)}`);
        }
        return;
      }
      if ((route !== DISPATCH && route !== STATUS) || answer.status !== 200) return;
      const envelope = record(route === DISPATCH ? request.dispatch : request.query);
      const orderId = envelope?.payload?.orderId;
      if (!envelope || typeof orderId !== "string") return;
      const dispatchHash = (route === DISPATCH ? canonicalHash(envelope) : envelope.payload.dispatchHash) as Hex;
      let accepted: Awaited<ReturnType<typeof acceptDispatchResponse>>;
      try {
        accepted = await acceptDispatchResponse(readBoundedAnswer(answer, profile.maxResponseBytes), {
          ...KEYS, dispatchHash, now,
        });
      } catch {
        return;
      }
      try {
        orders.set(orderId, nextObservation(orders.get(orderId) ?? null, {
          operations: accepted.operations, projectionHash: semanticOperationsHash(accepted.operations),
        }, accepted.evidence));
      } catch (error) {
        throw new ProviderWireDefect(`gateway verdict on a dispatch answer: ${(error as Error).message}`);
      }
    },
  };
}
