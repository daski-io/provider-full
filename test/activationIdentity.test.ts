import { describe, expect, it } from "vitest";
import {
  ReusedListingDriftError,
  crossCheckActivationCommitments,
  describeCrossCheck,
  resolveActivationCommitment,
} from "../src/core/gatewayRegistration/activationIdentity.js";
import type { RuntimeListingHead } from "../src/core/gatewayRegistration/runtimeCatalog.js";
import {
  buildRuntimeListingCommitment,
  runtimeCommitmentHash,
  type RuntimeCommitmentInputs,
} from "../src/core/gatewayRegistration/runtimeCommitment.js";
import type { GatewayListingPreparationV1 } from "../src/core/gatewayRegistration/types.js";
import type { SignedEnvelope } from "../src/core/standardRail/types.js";

// Two registrations of one service: the first admitted every listing (intent
// A); the second re-registers after a paid skill changed (intent B). The
// gateway reuses the unchanged listings verbatim, so the provider must expect
// their ORIGINAL commitments, including for a free skill that has neither a
// preparation nor a control profile to pin its intent hash.
const hash = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;
const address = (byte: string) => `0x${byte.repeat(40)}` as `0x${string}`;
const INTENT_A = hash("a1");
const INTENT_B = hash("b2");
// The gateway pins the same "re-registration revision vector" in its
// runtimeCommitment suite: the commitment both sides keep for this free
// listing across a re-registration.
const GOLDEN_REUSED_FREE_COMMITMENT =
  "0xcafef43cfe1be003cbc49cfd1d96791dfeaf7c5d9b1000331a10118a36517be3";
const FREE_LISTING = "11111111-1111-4111-8111-111111111111";
const PAID_LISTING = "22222222-2222-4222-8222-222222222222";
const NEW_LISTING = "99999999-9999-4999-8999-999999999999";

const preparation = (): SignedEnvelope<GatewayListingPreparationV1> => ({
  artifactType: "GatewayListingPreparationV1",
  schemaVersion: 1,
  environment: "testnet",
  chainId: 84532,
  audience: "https://gateway.example",
  signerKeyId: "gateway-protocol",
  issuedAt: 100,
  validBefore: 200,
  signature: `0x${"ab".repeat(65)}`,
  payload: {
    registrationId: "33333333-3333-4333-8333-333333333333",
    listingId: PAID_LISTING,
    listingKey: hash("77"),
    providerAgentId: "42",
    serviceId: hash("55"),
    serviceSlug: "orbital-logistics",
    serviceVersion: "1",
    skillId: "reserve-orbit",
    skillContractHash: hash("66"),
    skillContractSetHash: hash("67"),
    providerIntentHash: INTENT_A,
    canonicalToken: address("0a"),
    providerPayee: address("0b"),
    daskiCommissionReceiver: address("0c"),
    commissionBps: 500,
    splitterFactory: address("0d"),
    splitterDeploymentSalt: hash("88"),
    policyVersionHash: hash("99"),
    listingEpoch: "1",
  },
});

function inputs(
  currentProviderIntentHash: `0x${string}`,
  listing: Partial<RuntimeCommitmentInputs["listing"]> = {},
  payee = address("0b"),
): RuntimeCommitmentInputs {
  return {
    environment: "testnet",
    chainId: 84532,
    gatewayAudience: "https://gateway.example",
    providerAgentId: "42",
    serviceId: hash("55"),
    currentProviderIntentHash,
    currentProviderPayee: payee,
    policy: {
      canonicalToken: address("0a"),
      daskiCommissionReceiver: address("0c"),
      commissionBps: 500,
      policyVersionHash: hash("99"),
      splitterFactory: address("0d"),
    },
    listing: {
      listingId: FREE_LISTING,
      listingKey: hash("44"),
      skillId: "check-availability",
      skillContractHash: hash("33"),
      paymentRequired: false,
      splitterAddress: null,
      preparation: null,
      controlProfile: null,
      ...listing,
    },
  };
}

const paid = (intent: `0x${string}`) => inputs(intent, {
  listingId: PAID_LISTING,
  listingKey: hash("77"),
  skillId: "reserve-orbit",
  skillContractHash: hash("66"),
  paymentRequired: true,
  splitterAddress: address("0e"),
  preparation: preparation(),
});

function headFrom(admission: RuntimeCommitmentInputs): RuntimeListingHead {
  const commitment = buildRuntimeListingCommitment(admission);
  return {
    gatewayOrigin: "https://gateway.example",
    serviceId: admission.serviceId,
    skillId: admission.listing.skillId,
    listingId: admission.listing.listingId,
    listingKey: admission.listing.listingKey,
    paymentRequired: admission.listing.paymentRequired,
    runtimeCommitmentHash: runtimeCommitmentHash(commitment),
    runtimeCommitment: commitment,
    bundle: {} as RuntimeListingHead["bundle"],
    promotedAt: new Date("2026-08-30T21:25:11Z"),
  };
}

describe("resolveActivationCommitment", () => {
  it("keeps a reused free listing without a control profile on its admitted commitment", () => {
    const priorHead = headFrom(inputs(INTENT_A));
    const resolved = resolveActivationCommitment({
      inputs: inputs(INTENT_B),
      priorHead,
      gatewayReused: true,
    });
    expect(resolved.reused).toBe(true);
    expect(resolved.hash).toBe(priorHead.runtimeCommitmentHash);
    expect(resolved.hash).toBe(GOLDEN_REUSED_FREE_COMMITMENT);
    expect(resolved.commitment.providerIntentHash).toBe(INTENT_A);
    // The naive rebuild under the new registration's intent rotates it.
    expect(runtimeCommitmentHash(buildRuntimeListingCommitment(inputs(INTENT_B))))
      .not.toBe(priorHead.runtimeCommitmentHash);
  });

  it("reproduces a reused paid listing from its preparation whatever the current intent is", () => {
    const priorHead = headFrom(paid(INTENT_A));
    const resolved = resolveActivationCommitment({
      inputs: paid(INTENT_B),
      priorHead,
      gatewayReused: true,
    });
    expect(resolved).toMatchObject({ reused: true, hash: priorHead.runtimeCommitmentHash });
  });

  it("refuses a listing swapped under a reused id and names the differing fields", () => {
    const priorHead = headFrom(inputs(INTENT_A));
    const attempt = () => resolveActivationCommitment({
      inputs: inputs(INTENT_B, { skillContractHash: hash("ff") }, address("1f")),
      priorHead,
      gatewayReused: true,
    });
    expect(attempt).toThrow(ReusedListingDriftError);
    expect(attempt).toThrow(
      `check-availability was reused under listing ${FREE_LISTING} but no longer reproduces its promoted commitment (differs in: providerPayee, skillContractHash)`,
    );
  });

  it("refuses a reused free listing without an admitted head instead of rebuilding it", () => {
    const attempt = () => resolveActivationCommitment({
      inputs: inputs(INTENT_B),
      priorHead: undefined,
      gatewayReused: true,
    });
    expect(attempt).toThrow(ReusedListingDriftError);
    expect(attempt).toThrow(/no promoted commitment for that listing heads the local runtime catalog/);
  });

  it("reproduces a reused paid listing without a head from its signed preparation", () => {
    const resolved = resolveActivationCommitment({
      inputs: paid(INTENT_B),
      priorHead: undefined,
      gatewayReused: true,
    });
    expect(resolved.reused).toBe(false);
    expect(resolved.commitment.providerIntentHash).toBe(INTENT_A);
    expect(resolved.hash).toBe(headFrom(paid(INTENT_A)).runtimeCommitmentHash);
  });

  it("rebuilds a new admission from the current registration", () => {
    const priorHead = headFrom(inputs(INTENT_A));
    const readmitted = inputs(INTENT_B, { listingId: NEW_LISTING });
    const resolved = resolveActivationCommitment({
      inputs: readmitted,
      priorHead,
      gatewayReused: false,
    });
    expect(resolved.reused).toBe(false);
    expect(resolved.commitment.providerIntentHash).toBe(INTENT_B);
    expect(resolved.hash).toBe(runtimeCommitmentHash(buildRuntimeListingCommitment(readmitted)));
  });

  it("treats a replay of an already-promoted admission as its own head", () => {
    // A crash after promotion committed but before the record was marked
    // active: the new admission now heads the catalog and must reproduce.
    const admission = inputs(INTENT_B, { listingId: NEW_LISTING });
    const resolved = resolveActivationCommitment({
      inputs: admission,
      priorHead: headFrom(admission),
      gatewayReused: false,
    });
    expect(resolved).toMatchObject({ reused: true, hash: headFrom(admission).runtimeCommitmentHash });
  });
});

describe("crossCheckActivationCommitments", () => {
  const admission = inputs(INTENT_A);
  const priorHeads = new Map([[admission.listing.skillId, headFrom(admission)]]);
  const readmitted = inputs(INTENT_B, { listingId: NEW_LISTING, skillId: "get-quote" });
  const views = () => [
    { ...inputs(INTENT_B), gatewayReused: true },
    { ...readmitted, gatewayReused: false },
  ];

  it("passes an exact set: reused listings at their heads, new admissions rebuilt", () => {
    const check = crossCheckActivationCommitments({
      inputs: views(),
      reported: [
        { listingId: FREE_LISTING, runtimeCommitmentHash: priorHeads.get("check-availability")!.runtimeCommitmentHash },
        {
          listingId: NEW_LISTING,
          runtimeCommitmentHash: runtimeCommitmentHash(buildRuntimeListingCommitment(readmitted))
            .toUpperCase().replace("0X", "0x"),
        },
      ],
      priorHeads,
    });
    expect(check.ok).toBe(true);
    expect(check.verdicts.map((verdict) => verdict.reused)).toEqual([true, false]);
    expect(describeCrossCheck(check)).toBe("");
  });

  it("names every disagreement: a rotated hash, a missing listing, an extra id, a duplicate", () => {
    const naive = runtimeCommitmentHash(buildRuntimeListingCommitment(inputs(INTENT_B)));
    const check = crossCheckActivationCommitments({
      inputs: views(),
      reported: [
        { listingId: FREE_LISTING, runtimeCommitmentHash: naive },
        { listingId: FREE_LISTING, runtimeCommitmentHash: naive },
        { listingId: "77777777-7777-4777-8777-777777777777", runtimeCommitmentHash: hash("77") },
      ],
      priorHeads,
    });
    expect(check.ok).toBe(false);
    expect(check.duplicates).toBe(true);
    expect(check.extra).toEqual(["77777777-7777-4777-8777-777777777777"]);
    const detail = describeCrossCheck(check);
    expect(detail).toContain(
      `check-availability (${FREE_LISTING}, reused): expected ${priorHeads.get("check-availability")!.runtimeCommitmentHash}, reported ${naive}`,
    );
    expect(detail).toContain(`get-quote (${NEW_LISTING}): expected`);
    expect(detail).toContain("reported nothing");
    expect(detail).toContain("reported but not in the view: 77777777-7777-4777-8777-777777777777");
    expect(detail).toContain("duplicate listing ids");
    expect(detail).not.toMatch(/signature|0x(?:ab){65}/);
  });

  it("refuses, rather than reports, a reused listing that no longer reproduces its head", () => {
    expect(() => crossCheckActivationCommitments({
      inputs: [{ ...inputs(INTENT_B, { skillContractHash: hash("ff") }), gatewayReused: true }],
      reported: [],
      priorHeads,
    })).toThrow(ReusedListingDriftError);
  });
});
