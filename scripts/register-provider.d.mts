// Types for the operator identity script, so its exported steps can be
// exercised by the TypeScript test suite against a stubbed chain.
import type { Abi, AbiEvent } from "viem";

export declare const identityAbi: Abi;
export declare const transferEvent: AbiEvent;
export declare const agentIndexAbi: Abi;
export declare const provAbi: Abi;
export declare const usdcAbi: Abi;
export declare const DEFAULT_SCAN_BLOCKS: bigint;

export declare class RegistrationAbort extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode?: number);
}

export declare function parseAgentIdArg(argv: readonly string[]): bigint | undefined;
export declare function parseScanBlocksArg(argv: readonly string[]): bigint;
export declare function parseMintNewAgentArg(argv: readonly string[]): boolean;

export interface RegistrationStepsOptions {
  pub: unknown;
  wallet: unknown;
  account: { address: `0x${string}` };
  identity: `0x${string}`;
  agentIndex: `0x${string}`;
  providerRegistry: `0x${string}`;
  usdc: `0x${string}`;
  agentUri: string;
  updateUri?: boolean;
  agentIdArg?: bigint;
  scanBlocks?: bigint;
  mintNewAgent?: boolean;
  log?: (entry: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface RegistrationSteps {
  retryOnLag<T>(label: string, fn: () => Promise<T>): Promise<T>;
  heldAgents(balance: bigint, head: bigint): Promise<{ minted: bigint[]; transferredIn: bigint[] }>;
  ensureAgent(): Promise<{ agentId: bigint; registeredAt?: bigint }>;
  ensureAgentWallet(agentId: bigint, registeredAt: bigint | undefined): Promise<void>;
  reconcileUri(agentId: bigint): Promise<void>;
  ensureIndexed(agentId: bigint): Promise<void>;
  ensureListed(agentId: bigint): Promise<void>;
  run(): Promise<Record<string, unknown>>;
}

export declare function registrationSteps(options: RegistrationStepsOptions): RegistrationSteps;
export declare function main(argv?: readonly string[], env?: NodeJS.ProcessEnv): Promise<Record<string, unknown>>;
