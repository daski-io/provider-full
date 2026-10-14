import { defineConfig } from "vitest/config";

const criticalFiles = [
  "src/core/chain/providerWriteCoordinator.ts",
  "src/core/chain/runtimeTrust.ts",
  "src/core/chain/signerLease.ts",
  "src/core/auth/requestHash.ts",
  "src/core/standardRail/walletAuthorization.ts",
  "src/core/standardRail/payerSignature.ts",
  "src/core/compliance/lease.ts",
  "src/core/db/sessionAdvisoryLock.ts",
  "src/core/security/reviewedEndpoint.ts",
  "src/core/suppliers/operationJournal.ts",
];

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    include: [
      "test/providerWriteCoordinator.test.ts",
      "test/runtimeChainTrust.test.ts",
      "test/criticalLeaseBusyInvariant.test.ts",
      "test/criticalLeaseWrappers.test.ts",
      "test/sessionAdvisoryLock.test.ts",
      "test/requestHash.test.ts",
      "test/reviewedEndpoint.test.ts",
      "test/walletAuthorization.test.ts",
      "test/payerSignature.test.ts",
      "test/supplierOperationJournal.test.ts",
      "test/providerComposition.test.ts",
    ],
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: criticalFiles,
      reporter: ["text"],
      thresholds: {
        perFile: true,
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
