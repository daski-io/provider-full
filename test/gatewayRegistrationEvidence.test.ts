import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayRegistrationView,
  ProviderServiceRegistrationEvidenceEnvelope,
  RegistrationPolicy,
} from "../src/core/gatewayRegistration/types.js";

const h = vi.hoisted(() => ({ save: vi.fn(), post: vi.fn(), read: vi.fn() }));
vi.mock("../src/core/gatewayRegistration/store.js", () => ({ saveRegistrationEvidence: h.save }));
vi.mock("../src/core/gatewayRegistration/gatewayApi.js", () => ({
  postGatewayEvidence: h.post,
  getGatewayRegistrationView: h.read,
}));

import {
  GatewayRegistrationEndedError,
  activationPolling,
  awaitActivation,
  submitEvidence,
} from "../src/core/gatewayRegistration/evidence.js";
import { GatewayRegistrationHttpError } from "../src/core/gatewayRegistration/wire.js";
import { canonicalHash } from "../src/core/standardRail/canonical.js";

const hash = `0x${"a".repeat(64)}` as const;
const prepared = { registrationId: "registration", listings: [] } as unknown as
  GatewayRegistrationView["prepared"];
const view = (state: GatewayRegistrationView["state"]) =>
  ({ registrationId: "registration", state, prepared }) as GatewayRegistrationView;
const now = () => Math.floor(Date.now() / 1_000);

function args(state: GatewayRegistrationView["state"], validBefore = now() + 300) {
  return {
    gatewayOrigin: "https://gateway.example",
    localId: "local",
    view: view(state),
    splitterHashes: [],
    policy: {
      environment: "testnet",
      chainId: 84532,
      audience: "https://gateway.example",
      intentMaximumLifetimeSeconds: 600,
    } as RegistrationPolicy,
    existingEvidence: {
      validBefore,
      signature: `0x${"cd".repeat(65)}`,
      payload: {
        registrationId: "registration",
        preparedRegistrationHash: canonicalHash(prepared),
        splitterTransactionHashes: [{ listingId: "listing", transactionHash: hash }],
        expectedState: "PREPARED",
        evidenceNonce: hash,
      },
    } as ProviderServiceRegistrationEvidenceEnvelope,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.post.mockImplementation(async () => view("ACTIVE"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("evidence awaiting first acceptance", () => {
  it("re-signs expired evidence over the same binding and persists it before posting", async () => {
    const input = args("PREPARED", now());
    const { evidence } = await submitEvidence(input);
    expect(evidence.validBefore).toBeGreaterThan(input.existingEvidence.validBefore);
    expect(evidence.payload).toEqual({
      ...input.existingEvidence.payload,
      evidenceNonce: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    expect(evidence.payload.evidenceNonce).not.toBe(hash);
    expect(h.save).toHaveBeenCalledWith("local", evidence, input.existingEvidence);
    expect(h.save.mock.invocationCallOrder[0]).toBeLessThan(h.post.mock.invocationCallOrder[0]!);
    expect(h.post).toHaveBeenCalledWith("https://gateway.example", "registration", evidence);
  });

  it("posts a still-valid envelope as is and re-signs it once after an auth refusal", async () => {
    const input = args("PREPARED");
    expect((await submitEvidence(input)).evidence).toBe(input.existingEvidence);
    expect(h.save).not.toHaveBeenCalled();

    h.post.mockRejectedValueOnce(new GatewayRegistrationHttpError(401, "EVIDENCE_AUTH_INVALID"));
    await submitEvidence(input);
    expect(h.post).toHaveBeenCalledTimes(3);
    expect(h.save).toHaveBeenCalledTimes(1);

    h.post.mockRejectedValue(new GatewayRegistrationHttpError(401, "EVIDENCE_AUTH_INVALID"));
    await expect(submitEvidence(input)).rejects.toThrow("401");
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it("signs the first envelope with the live PREPARED state", async () => {
    const input = { ...args("PREPARED"), existingEvidence: null };
    const { evidence } = await submitEvidence(input);
    expect(evidence.payload.expectedState).toBe("PREPARED");
    expect(evidence.payload.preparedRegistrationHash).toBe(canonicalHash(prepared));
    expect(h.save).toHaveBeenCalledWith("local", evidence, null);
  });
});

describe("accepted evidence", () => {
  it("replays the exact envelope after its expiry and never re-signs it", async () => {
    const input = args("EVIDENCE_PENDING", now() - 3_600);
    expect((await submitEvidence(input)).evidence).toBe(input.existingEvidence);
    expect(h.post).toHaveBeenCalledWith("https://gateway.example", "registration", input.existingEvidence);

    h.post.mockRejectedValue(new GatewayRegistrationHttpError(401, "EVIDENCE_AUTH_INVALID"));
    await expect(submitEvidence(input)).rejects.toThrow("401");
    expect(h.save).not.toHaveBeenCalled();
  });

  it("refuses to sign a replacement for evidence the gateway accepted elsewhere", async () => {
    await expect(submitEvidence({ ...args("EVIDENCE_PENDING"), existingEvidence: null }))
      .rejects.toThrow(/accepted evidence this provider has not persisted/);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });

  it("refuses to post evidence that does not bind the live registration", async () => {
    const input = args("EVIDENCE_PENDING");
    input.view = { ...input.view, prepared: { ...prepared, listings: [{}] } } as GatewayRegistrationView;
    await expect(submitEvidence(input)).rejects.toThrow(/does not bind gateway registration/);
    expect(h.post).not.toHaveBeenCalled();
  });
});

describe("activation polling", () => {
  it("polls every 20 seconds by default and rekicks with an exact replay while pending", async () => {
    expect(activationPolling()).toEqual({ intervalMs: 20_000, timeoutMs: 1_800_000, rekickMs: 60_000 });
    const input = args("EVIDENCE_PENDING", now() - 1);
    h.read.mockResolvedValue(view("EVIDENCE_PENDING"));
    h.post.mockResolvedValue(view("EVIDENCE_PENDING"));
    const active = awaitActivation(input, input.existingEvidence);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40_001);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]![2]).toBe(input.existingEvidence);
    expect(h.save).not.toHaveBeenCalled();
    h.read.mockResolvedValue(view("ACTIVE"));
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(active).resolves.toMatchObject({ state: "ACTIVE" });
  });

  it("stops with a typed error once the gateway ends the registration", async () => {
    const input = args("EVIDENCE_PENDING");
    h.read.mockResolvedValue(view("REJECTED"));
    const outcome = awaitActivation(input, input.existingEvidence).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(GatewayRegistrationEndedError);
    expect(error).toMatchObject({ state: "REJECTED", registrationId: "registration" });
  });

  it("rejects malformed polling overrides instead of spinning", () => {
    vi.stubEnv("REGISTRATION_ACTIVATION_POLL_MS", "fast");
    expect(() => activationPolling()).toThrow(/REGISTRATION_ACTIVATION_POLL_MS must be an integer/);
    vi.stubEnv("REGISTRATION_ACTIVATION_POLL_MS", "10");
    expect(() => activationPolling()).toThrow(/from 1000 to 600000/);
  });
});
