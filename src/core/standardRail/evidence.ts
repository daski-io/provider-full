import {
  createPublicClient,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  type Chain,
  type Hex,
} from "viem";
import { logWarn } from "../logger.js";
import { assertExactKeys, canonicalHash, recipeNonce, recipeNonceV2 } from "./canonical.js";
import { loadLogsPaged } from "./chainLogPagination.js";
import { assertActivationCheckpoint } from "./evidenceCheckpoint.js";
import {
  selectPreviousRelease,
  selectReleaseAtPosition,
  type ReleasedLog,
} from "./evidencePosition.js";
import { hasRequiredConfirmations } from "./finality.js";
import {
  assertDepositWithinQuoteWindow,
  selectDepositAuthorization,
} from "./paymentBinding.js";
import { verifyReleaseCoverage } from "./releaseCoverage.js";
import {
  assertSplitterDeploymentProvenance,
  splitterEvidenceAbi,
  splitterFactoryAbi,
} from "./splitterProvenance.js";
import type { ProviderStandardRailConfig } from "./config.js";
import { withRpcFailover } from "../chain/rpcFailover.js";
import { orderedRpcTransport } from "./orderedRpcTransport.js";
import type {
  ProviderOutcomeConfig,
  QuoteV1,
  SignedEnvelope,
  StandardEvidenceBundleV2,
  StandardRailDispatchV2,
} from "./types.js";

const authorizationAbi = parseAbi([
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
]);
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from,address indexed to,uint256 value)",
);
const releasedEvent = parseAbiItem(
  "event Released(bytes32 indexed outcomeIdHash,uint64 indexed listingEpoch,uint64 indexed releaseSequence,bytes32 policyVersionHash,bytes32 listingCommitmentHash,uint256 grossAmount,uint256 providerNetAmount,uint256 daskiCommissionAmount)",
);
const sanctionsOracleAbi = parseAbi([
  "function isSanctioned(address account) view returns (bool)",
]);
const tokenPolicyAbi = parseAbi([
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

export class ProviderEvidenceVerifier {
  private readonly clients;

  constructor(private readonly config: ProviderStandardRailConfig, chain: Chain) {
    this.clients = config.evidenceRpcUrls.map((url) => ({
      host: new URL(url).hostname,
      client: createPublicClient({
        chain,
        transport: orderedRpcTransport(http(url, { retryCount: 0, timeout: 20_000 })),
      }),
    }));
  }

  private observe<Result>(
    work: (endpoint: (typeof this.clients)[number]) => Promise<Result>,
  ): Promise<Result> {
    return withRpcFailover(this.clients, work, {
      onFallback: ({ primaryHost, selectedHost }) => {
        logWarn("Standard-rail RPC fallback selected", {
          primaryHost,
          selectedHost,
        });
      },
    });
  }

  async verifyReadiness(): Promise<void> {
    await this.observe(async ({ client }) => {
      const outcomes = [...this.config.outcomes.values()];
      await Promise.all(outcomes.map(async (outcome) => {
        await this.verifySplitterDeployment(client, outcome);
        await this.verifyActivationCheckpoint(client, outcome);
      }));

      const head = await this.verifyLiveReadinessOnClient(client);
      await Promise.all(outcomes.map(async (outcome) => {
        const [splitterCode, factoryCode] = await Promise.all([
          client.getCode({ address: getAddress(outcome.splitter), blockNumber: head }),
          client.getCode({ address: getAddress(outcome.splitterFactory), blockNumber: head }),
        ]);
        if (
          !splitterCode ||
          keccak256(splitterCode) !== outcome.splitterRuntimeCodeHash ||
          !factoryCode ||
          keccak256(factoryCode) !== outcome.splitterFactoryRuntimeCodeHash
        ) throw new Error(`Runtime evidence mismatch for ${outcome.outcomeId}`);
      }));
    });
  }

  async verifyLiveReadiness(): Promise<void> {
    await this.observe(async ({ client }) => {
      await this.verifyLiveReadinessOnClient(client);
    });
  }

  private async verifyLiveReadinessOnClient(
    client: (typeof this.clients)[number]["client"],
  ): Promise<bigint> {
    // Global chain facts come from the deployment-owned rail policy, so an
    // empty catalog (pre-bootstrap boot: the provider must be up to serve
    // its cards before any listing can be registered) still proves the
    // oracle, EAS, and canonical-token evidence.
    const policy = this.config.globalPolicy.chainEvidencePolicy.payload;
    const token = getAddress(policy.canonicalToken);

    const head = await client.getBlockNumber();
    const [oracleCode, easCode, tokenCode, implementationStorage, domainSeparator] =
      await Promise.all([
        client.getCode({
          address: this.config.sanctionsOracleAddress,
          blockNumber: head,
        }),
        client.getCode({ address: this.config.easAddress, blockNumber: head }),
        client.getCode({ address: token, blockNumber: head }),
        client.getStorageAt({
          address: token,
          slot: policy.tokenImplementationSlot,
          blockNumber: head,
        }),
        client.readContract({
          address: token,
          abi: tokenPolicyAbi,
          functionName: "DOMAIN_SEPARATOR",
          blockNumber: head,
        }),
      ]);
    if (
      !oracleCode ||
      keccak256(oracleCode) !== this.config.globalPolicy.sanctionsOracleRuntimeCodeHash
    ) {
      throw new Error("Sanctions oracle runtime code is unavailable or changed");
    }
    if (!easCode || keccak256(easCode) !== this.config.easRuntimeCodeHash) {
      throw new Error("EAS runtime code is unavailable or changed");
    }
    if (!implementationStorage) {
      throw new Error("Token implementation evidence is unavailable");
    }
    const implementation = getAddress(`0x${implementationStorage.slice(-40)}`);
    const implementationCode = await client.getCode({
      address: implementation,
      blockNumber: head,
    });
    if (
      !tokenCode ||
      keccak256(tokenCode) !== policy.canonicalTokenRuntimeCodeHash ||
      implementation !== getAddress(policy.tokenImplementationAddress) ||
      !implementationCode ||
      keccak256(implementationCode) !== policy.tokenImplementationRuntimeCodeHash ||
      domainSeparator !== policy.tokenDomainSeparator
    ) throw new Error("Canonical token runtime evidence changed");
    return head;
  }

  async verify(args: {
    dispatch: StandardRailDispatchV2;
    quote: SignedEnvelope<QuoteV1>;
    outcome: ProviderOutcomeConfig;
    bundle: StandardEvidenceBundleV2;
  }): Promise<{ authorizationKey: Hex }> {
    this.assertEvidenceBundle(args.dispatch, args.bundle);
    const authorizationKey = await this.observe(async ({ client }) => {
      const depositBlock = BigInt(args.dispatch.depositBlockNumber);
      const releaseBlock = BigInt(args.dispatch.releaseBlockNumber);
      const [
        depositReceipt,
        releaseReceipt,
        depositBlockHeader,
        head,
        depositTokenCode,
        splitterCode,
        depositImplementationStorage,
        depositDomainSeparator,
      ] = await Promise.all([
        client.getTransactionReceipt({ hash: args.dispatch.settlementTxHash }),
        client.getTransactionReceipt({ hash: args.dispatch.releaseTxHash }),
        client.getBlock({ blockNumber: depositBlock }),
        client.getBlockNumber(),
        client.getCode({ address: getAddress(args.outcome.token), blockNumber: depositBlock }),
        client.getCode({ address: getAddress(args.outcome.splitter), blockNumber: releaseBlock }),
        client.getStorageAt({
          address: getAddress(args.outcome.token),
          slot: args.outcome.tokenImplementationSlot,
          blockNumber: depositBlock,
        }),
        client.readContract({
          address: getAddress(args.outcome.token),
          abi: tokenPolicyAbi,
          functionName: "DOMAIN_SEPARATOR",
          blockNumber: depositBlock,
        }),
      ]);
      if (!depositImplementationStorage) {
        throw new Error("Token implementation evidence is unavailable");
      }
      const depositImplementation = getAddress(
        `0x${depositImplementationStorage.slice(-40)}`,
      );
      const [
        depositImplementationCode,
        releaseTokenCode,
        releaseImplementationStorage,
        releaseDomainSeparator,
      ] = await Promise.all([
        client.getCode({ address: depositImplementation, blockNumber: depositBlock }),
        client.getCode({ address: getAddress(args.outcome.token), blockNumber: releaseBlock }),
        client.getStorageAt({
          address: getAddress(args.outcome.token),
          slot: args.outcome.tokenImplementationSlot,
          blockNumber: releaseBlock,
        }),
        client.readContract({
          address: getAddress(args.outcome.token),
          abi: tokenPolicyAbi,
          functionName: "DOMAIN_SEPARATOR",
          blockNumber: releaseBlock,
        }),
      ]);
      if (!releaseImplementationStorage) {
        throw new Error("Release token implementation evidence is unavailable");
      }
      const releaseImplementation = getAddress(
        `0x${releaseImplementationStorage.slice(-40)}`,
      );
      const releaseImplementationCode = await client.getCode({
        address: releaseImplementation,
        blockNumber: releaseBlock,
      });

      if (
        depositReceipt.status !== "success" ||
        releaseReceipt.status !== "success" ||
        !hasRequiredConfirmations(head, depositReceipt.blockNumber, this.config.finalityConfirmations) ||
        !hasRequiredConfirmations(head, releaseReceipt.blockNumber, this.config.finalityConfirmations) ||
        depositReceipt.transactionHash.toLowerCase() !== args.dispatch.settlementTxHash.toLowerCase() ||
        releaseReceipt.transactionHash.toLowerCase() !== args.dispatch.releaseTxHash.toLowerCase() ||
        depositReceipt.blockNumber !== depositBlock ||
        releaseReceipt.blockNumber !== releaseBlock ||
        depositReceipt.blockHash.toLowerCase() !== args.dispatch.depositBlockHash.toLowerCase() ||
        releaseReceipt.blockHash.toLowerCase() !== args.dispatch.releaseBlockHash.toLowerCase() ||
        depositReceipt.transactionIndex !== args.dispatch.depositTransactionIndex ||
        releaseReceipt.transactionIndex !== args.dispatch.releaseTransactionIndex ||
        !depositBlockHeader.hash ||
        depositBlockHeader.hash.toLowerCase() !== args.dispatch.depositBlockHash.toLowerCase()
      ) throw new Error("Provider evidence is not finalized or canonical");
      const depositTimestamp = Number(depositBlockHeader.timestamp);
      assertDepositWithinQuoteWindow(depositTimestamp, args.quote);
      if (
        !depositTokenCode ||
        keccak256(depositTokenCode) !== args.outcome.tokenRuntimeCodeHash ||
        depositImplementation !== getAddress(args.outcome.tokenImplementationAddress) ||
        !depositImplementationCode ||
        keccak256(depositImplementationCode) !== args.outcome.tokenImplementationRuntimeCodeHash ||
        depositDomainSeparator !== args.outcome.tokenDomainSeparator ||
        !releaseTokenCode ||
        keccak256(releaseTokenCode) !== args.outcome.tokenRuntimeCodeHash ||
        releaseImplementation !== getAddress(args.outcome.tokenImplementationAddress) ||
        !releaseImplementationCode ||
        keccak256(releaseImplementationCode) !== args.outcome.tokenImplementationRuntimeCodeHash ||
        releaseDomainSeparator !== args.outcome.tokenDomainSeparator ||
        !splitterCode ||
        keccak256(splitterCode) !== args.outcome.splitterRuntimeCodeHash
      ) throw new Error("Token or splitter runtime code changed");

      const paid = parseEventLogs({
        abi: erc20Abi,
        logs: depositReceipt.logs,
        eventName: "Transfer",
      }).filter((event) =>
        event.address.toLowerCase() === args.outcome.token.toLowerCase() &&
        event.blockNumber === depositBlock &&
        event.transactionIndex === args.dispatch.depositTransactionIndex &&
        Number(event.logIndex) === args.dispatch.depositLogIndex &&
        event.args.from !== undefined &&
        getAddress(event.args.from) === getAddress(args.dispatch.payer) &&
        event.args.to !== undefined &&
        getAddress(event.args.to) === getAddress(args.outcome.splitter) &&
        event.args.value === BigInt(args.dispatch.grossAmount)
      );
      if (paid.length !== 1) {
        throw new Error("Exact deposit transfer event is missing or ambiguous");
      }
      const usedByPayer = parseEventLogs({
        abi: authorizationAbi,
        logs: depositReceipt.logs,
        eventName: "AuthorizationUsed",
      }).filter((event) =>
        event.address.toLowerCase() === args.outcome.token.toLowerCase() &&
        event.args.authorizer !== undefined &&
        getAddress(event.args.authorizer) === getAddress(args.dispatch.payer)
      );
      const expectedNonce = args.dispatch.bindingProfile === "recipe-bound-v1"
        ? recipeNonce({
            chainId: args.dispatch.chainId,
            canonicalToken: getAddress(args.outcome.token),
            payer: getAddress(args.dispatch.payer),
            splitter: getAddress(args.outcome.splitter),
            grossAmount: BigInt(args.dispatch.grossAmount),
            listingManifestHash: args.dispatch.listingManifestHash,
            providerOfferHash: args.dispatch.providerOfferHash,
            quoteHash: args.dispatch.quoteHash,
            canonicalRequestHash: args.dispatch.canonicalRequestHash,
            orderNonce: args.dispatch.orderNonce,
          })
        : args.dispatch.bindingProfile === "recipe-bound-v2"
          // Option A slot layout: the two deal-document slots carry the
          // runtime listing commitment hash and the provider intent hash.
          ? recipeNonceV2({
              chainId: args.dispatch.chainId,
              canonicalToken: getAddress(args.outcome.token),
              payer: getAddress(args.dispatch.payer),
              splitter: getAddress(args.outcome.splitter),
              grossAmount: BigInt(args.dispatch.grossAmount),
              runtimeCommitmentHash: args.dispatch.listingManifestHash,
              providerIntentHash: args.dispatch.providerOfferHash,
              quoteHash: args.dispatch.quoteHash,
              canonicalRequestHash: args.dispatch.canonicalRequestHash,
              orderNonce: args.dispatch.orderNonce,
            })
          : null;
      const authorizationNonce = selectDepositAuthorization(usedByPayer, {
        depositLogIndex: args.dispatch.depositLogIndex,
        expectedNonce,
      }).args.nonce!;

      const releases = parseEventLogs({
        abi: splitterEvidenceAbi,
        logs: releaseReceipt.logs,
        eventName: "Released",
      });
      const releaseSequence = BigInt(args.dispatch.releaseSequence);
      const release = selectReleaseAtPosition(releases, getAddress(args.outcome.splitter), {
        blockNumber: releaseBlock,
        transactionIndex: args.dispatch.releaseTransactionIndex,
        logIndex: args.dispatch.releaseLogIndex,
        releaseSequence,
      });
      const activationBlock = BigInt(args.outcome.splitterActivationBlockNumber);
      const startingSequence = BigInt(args.outcome.splitterStartingReleaseSequence);
      if (
        depositBlock <= activationBlock ||
        releaseBlock <= activationBlock ||
        releaseSequence <= startingSequence
      ) throw new Error("Evidence is not after the signed activation checkpoint");

      let previousRelease: ReleasedLog | null = null;
      let initialBalance: bigint;
      let intervalFromBlock: bigint;
      if (releaseSequence === startingSequence + 1n) {
        initialBalance = BigInt(args.outcome.splitterStartingTokenBalance);
        intervalFromBlock = activationBlock + 1n;
      } else {
        const previousCandidates = await loadLogsPaged({
          fromBlock: activationBlock + 1n,
          toBlock: releaseBlock,
          maximumPageEvents: args.outcome.maximumLogPageEvents,
          load: (fromBlock, toBlock) => client.getLogs({
            address: getAddress(args.outcome.splitter),
            event: releasedEvent,
            args: { releaseSequence: releaseSequence - 1n },
            fromBlock,
            toBlock,
          }),
        });
        const selectedPrevious = selectPreviousRelease(
          previousCandidates,
          release,
          releaseSequence - 1n,
        );
        previousRelease = selectedPrevious;
        initialBalance = 0n;
        intervalFromBlock = selectedPrevious.blockNumber!;
      }
      const credits = await loadLogsPaged({
        fromBlock: intervalFromBlock,
        toBlock: releaseBlock,
        maximumPageEvents: args.outcome.maximumLogPageEvents,
        load: (fromBlock, toBlock) => client.getLogs({
          address: getAddress(args.outcome.token),
          event: transferEvent,
          args: { to: getAddress(args.outcome.splitter) },
          fromBlock,
          toBlock,
        }),
      });
      const receiptTransfers = parseEventLogs({
        abi: erc20Abi,
        logs: releaseReceipt.logs,
        eventName: "Transfer",
      });
      verifyReleaseCoverage({
        token: getAddress(args.outcome.token),
        splitter: getAddress(args.outcome.splitter),
        providerPayee: getAddress(args.outcome.providerPayee),
        daskiCommissionReceiver: getAddress(args.outcome.daskiCommissionReceiver),
        commissionBps: args.outcome.commissionBps,
        outcomeIdHash: args.outcome.outcomeIdHash,
        listingEpoch: BigInt(args.outcome.listingEpoch),
        policyVersionHash: args.outcome.policyVersionHash,
        listingCommitmentHash: args.outcome.listingCommitmentHash,
        initialBalance,
        previousRelease,
        release,
        credits,
        receiptTransfers,
        deposit: {
          transactionHash: args.dispatch.settlementTxHash,
          blockNumber: depositBlock,
          transactionIndex: args.dispatch.depositTransactionIndex,
          logIndex: args.dispatch.depositLogIndex,
          payer: getAddress(args.dispatch.payer),
          grossAmount: BigInt(args.dispatch.grossAmount),
        },
        expectedProviderNetAmount: BigInt(args.dispatch.providerNetAmount),
        expectedDaskiCommissionAmount: BigInt(args.dispatch.daskiCommissionAmount),
      });
      return keccak256(encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
        [
          BigInt(args.dispatch.chainId),
          getAddress(args.outcome.token),
          getAddress(args.dispatch.payer),
          authorizationNonce,
        ],
      ));
    });
    return { authorizationKey };
  }

  async assertNotSanctioned(account: Hex): Promise<void> {
    const expectedCodeHash = [...this.config.outcomes.values()][0]!
      .sanctionsOracleRuntimeCodeHash;
    const observation = await this.observe(async ({ client }) => {
      const head = await client.getBlockNumber();
      const [code, sanctioned] = await Promise.all([
        client.getCode({
          address: this.config.sanctionsOracleAddress,
          blockNumber: head,
        }),
        client.readContract({
          address: this.config.sanctionsOracleAddress,
          abi: sanctionsOracleAbi,
          functionName: "isSanctioned",
          args: [getAddress(account)],
          blockNumber: head,
        }),
      ]);
      if (!code || keccak256(code) !== expectedCodeHash) {
        throw new Error("Screening oracle runtime code changed");
      }
      return { head, sanctioned };
    });
    if (observation.sanctioned) {
      throw new Error("Standard-rail participant is sanctioned");
    }
  }

  private assertEvidenceBundle(
    dispatch: StandardRailDispatchV2,
    bundle: StandardEvidenceBundleV2,
  ): void {
    assertExactKeys(bundle, ["deposit", "release"], "evidence bundle V2");
    assertExactKeys(bundle.deposit, [
      "transactionHash", "blockNumber", "blockHash", "transactionIndex", "logIndex",
      "evidenceHash", "canonicalEvidence", "sources",
    ], "deposit evidence V2");
    assertExactKeys(bundle.release, [
      "transactionHash", "blockNumber", "blockHash", "transactionIndex", "logIndex",
      "releaseSequence", "evidenceHash", "canonicalEvidence", "sources",
    ], "release evidence V2");
    if (
      canonicalHash(bundle.deposit.canonicalEvidence) !== dispatch.depositEvidenceHash ||
      canonicalHash(bundle.release.canonicalEvidence) !== dispatch.releaseEvidenceHash ||
      bundle.deposit.evidenceHash !== dispatch.depositEvidenceHash ||
      bundle.release.evidenceHash !== dispatch.releaseEvidenceHash ||
      bundle.deposit.transactionHash.toLowerCase() !== dispatch.settlementTxHash.toLowerCase() ||
      bundle.deposit.blockNumber !== dispatch.depositBlockNumber ||
      bundle.deposit.blockHash.toLowerCase() !== dispatch.depositBlockHash.toLowerCase() ||
      bundle.deposit.transactionIndex !== dispatch.depositTransactionIndex ||
      bundle.deposit.logIndex !== dispatch.depositLogIndex ||
      bundle.release.transactionHash.toLowerCase() !== dispatch.releaseTxHash.toLowerCase() ||
      bundle.release.blockNumber !== dispatch.releaseBlockNumber ||
      bundle.release.blockHash.toLowerCase() !== dispatch.releaseBlockHash.toLowerCase() ||
      bundle.release.transactionIndex !== dispatch.releaseTransactionIndex ||
      bundle.release.logIndex !== dispatch.releaseLogIndex ||
      bundle.release.releaseSequence !== dispatch.releaseSequence
    ) throw new Error("Gateway evidence bundle V2 does not match the signed dispatch");
  }

  private async verifyActivationCheckpoint(
    client: (typeof this.clients)[number]["client"],
    outcome: ProviderOutcomeConfig,
  ) {
    const blockNumber = BigInt(outcome.splitterActivationBlockNumber);
    const [block, balance, releaseSequence, tokenCode, splitterCode, factoryCode] =
      await Promise.all([
        client.getBlock({ blockNumber }),
        client.readContract({
          address: getAddress(outcome.token),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [getAddress(outcome.splitter)],
          blockNumber,
        }),
        client.readContract({
          address: getAddress(outcome.splitter),
          abi: splitterEvidenceAbi,
          functionName: "releaseSequence",
          blockNumber,
        }),
        client.getCode({ address: getAddress(outcome.token), blockNumber }),
        client.getCode({ address: getAddress(outcome.splitter), blockNumber }),
        client.getCode({ address: getAddress(outcome.splitterFactory), blockNumber }),
      ]);
    if (!tokenCode || !splitterCode || !factoryCode) {
      throw new Error("Activation checkpoint runtime code is unavailable");
    }
    return assertActivationCheckpoint(outcome, {
      blockNumber: blockNumber.toString(),
      blockHash: block.hash,
      position: "END_OF_BLOCK",
      tokenBalance: balance.toString(),
      releaseSequence: releaseSequence.toString(),
      tokenCodeHash: keccak256(tokenCode),
      splitterCodeHash: keccak256(splitterCode),
      factoryCodeHash: keccak256(factoryCode),
    });
  }

  private async verifySplitterDeployment(
    client: (typeof this.clients)[number]["client"],
    outcome: ProviderOutcomeConfig,
  ): Promise<void> {
    const blockNumber = BigInt(outcome.splitterDeploymentBlockNumber);
    const [receipt, transaction, factoryCode, splitterCode] = await Promise.all([
      client.getTransactionReceipt({ hash: outcome.splitterDeploymentTransaction }),
      client.getTransaction({ hash: outcome.splitterDeploymentTransaction }),
      client.getCode({ address: getAddress(outcome.splitterFactory), blockNumber }),
      client.getCode({ address: getAddress(outcome.splitter), blockNumber }),
    ]);
    if (!factoryCode || !splitterCode) {
      throw new Error("Splitter deployment runtime code is unavailable");
    }
    const [
      canonicalChainId,
      canonicalToken,
      providerPayee,
      daskiCommissionReceiver,
      commissionBps,
      policyVersionHash,
      outcomeIdHash,
      listingCommitmentHash,
      listingEpoch,
    ] = await Promise.all([
      client.readContract({
        address: getAddress(outcome.splitter), abi: splitterEvidenceAbi,
        functionName: "canonicalChainId", blockNumber,
      }),
      client.readContract({
        address: getAddress(outcome.splitter), abi: splitterEvidenceAbi,
        functionName: "canonicalToken", blockNumber,
      }),
      client.readContract({
        address: getAddress(outcome.splitter), abi: splitterEvidenceAbi,
        functionName: "providerPayee", blockNumber,
      }),
      client.readContract({
        address: getAddress(outcome.splitter), abi: splitterEvidenceAbi,
        functionName: "daskiCommissionReceiver", blockNumber,
      }),
      client.readContract({
        address: getAddress(outcome.splitter), abi: splitterEvidenceAbi,
        functionName: "commissionBps", blockNumber,
      }),
      client.readContract({
        address: getAddress(outcome.splitter), abi: splitterEvidenceAbi,
        functionName: "policyVersionHash", blockNumber,
      }),
      client.readContract({
        address: getAddress(outcome.splitter), abi: splitterEvidenceAbi,
        functionName: "outcomeIdHash", blockNumber,
      }),
      client.readContract({
        address: getAddress(outcome.splitter), abi: splitterEvidenceAbi,
        functionName: "listingCommitmentHash", blockNumber,
      }),
      client.readContract({
        address: getAddress(outcome.splitter), abi: splitterEvidenceAbi,
        functionName: "listingEpoch", blockNumber,
      }),
    ]);
    const events = parseEventLogs({
      abi: splitterFactoryAbi,
      logs: receipt.logs,
      eventName: "OutcomeSplitterDeployed",
    }).map((event) => ({
      emitter: event.address,
      splitter: event.args.splitter,
      salt: event.args.salt,
      outcomeIdHash: event.args.outcomeIdHash,
      listingEpoch: event.args.listingEpoch,
      listingCommitmentHash: event.args.listingCommitmentHash,
    }));
    assertSplitterDeploymentProvenance(outcome, this.config.chainId, {
      receiptStatus: receipt.status,
      receiptTransactionHash: receipt.transactionHash,
      receiptBlockNumber: receipt.blockNumber,
      receiptBlockHash: receipt.blockHash,
      transactionHash: transaction.hash,
      transactionTo: transaction.to,
      transactionValue: transaction.value,
      transactionInput: transaction.input,
      transactionBlockNumber: transaction.blockNumber,
      transactionBlockHash: transaction.blockHash,
      factoryRuntimeCodeHash: keccak256(factoryCode),
      splitterRuntimeCodeHash: keccak256(splitterCode),
      events,
      immutables: {
        canonicalChainId,
        canonicalToken,
        providerPayee,
        daskiCommissionReceiver,
        commissionBps,
        policyVersionHash,
        outcomeIdHash,
        listingCommitmentHash,
        listingEpoch,
      },
    });
  }
}
