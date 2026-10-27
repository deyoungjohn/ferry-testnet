import { describe, it, expect } from 'vitest';
import { SolverConfigSchema } from '../src/config.js';
import {
  runStartupSelfCheck,
  StartupSelfCheckError,
  EXPECTED_BCH_GENESIS,
} from '../src/ops/self-check.js';

describe('Startup Self-Check', () => {
  const validEvmAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
  const validBchWif = 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA';
  const dummyBytecode =
    '0x608060405234801561001057600080fd5b50610123806100206000396000f3fe' as const;

  const createMockConfig = (overrides = {}) =>
    SolverConfigSchema.parse({
      solverEvmPrivateKey:
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      solverBchWif: validBchWif,
      baseChainId: 84532,
      baseHtlcAddress: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641',
      baseUsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      network: 'testnet',
      ...overrides,
    });

  const createMockPublicClient = (overrides = {}) => ({
    getChainId: async () => 84532,
    getBytecode: async () => dummyBytecode,
    getBalance: async () => 50000000000000000n, // 0.05 ETH
    readContract: async () => 20000000n, // 20.00 USDC
    ...overrides,
  });

  const createMockBchClient = (overrides = {}) => ({
    getQuorumStatus: () => ({
      isQuorumHealthy: true,
      quorumTip: 330000,
      genesisHash: EXPECTED_BCH_GENESIS.chipnet,
    }),
    listUnspent: async () => [
      {
        value: 1000000,
        token: {
          category:
            'ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac',
          amount: 5000000000n,
        },
      },
    ],
    ...overrides,
  });

  it('passes cleanly when chain ID, genesis hash, contract bytecodes, and balances match', async () => {
    const config = createMockConfig();
    const publicClient = createMockPublicClient();
    const bchClient = createMockBchClient();

    const result = await runStartupSelfCheck({
      config,
      publicClient,
      bchClient,
      solverEvmAddress: validEvmAddress,
      solverBchWif: validBchWif,
    });

    expect(result.passed).toBe(true);
    expect(result.chainIds.matches).toBe(true);
    expect(result.genesisHashes.matches).toBe(true);
    expect(result.contractCodeHashes.htlc.codeHash).toMatch(
      /^0x[0-9a-fA-F]{64}$/,
    );
    expect(result.contractCodeHashes.usdc.codeHash).toMatch(
      /^0x[0-9a-fA-F]{64}$/,
    );
    expect(result.balances.evmNativeWei).toBe(50000000000000000n);
    expect(result.balances.evmUsdcUnits).toBe(20000000n);
    expect(result.balances.bchSats).toBe(1000000n);
    expect(result.balances.bchTokenUnits).toBe(5000000000n);

    // Verify printed report output
    expect(result.report).toContain('FERRYMAN STARTUP SELF-CHECK');
    expect(result.report).toContain(validEvmAddress);
    expect(result.report).toContain('84532');
    expect(result.report).toContain(EXPECTED_BCH_GENESIS.chipnet);

    // Verify STRICT SECRET PRIVACY: private key and WIF are never in output
    expect(result.report).not.toContain(config.solverEvmPrivateKey);
    expect(result.report).not.toContain(validBchWif);
  });

  it('refuses startup on EVM Chain ID mismatch', async () => {
    const config = createMockConfig({ baseChainId: 84532 });
    const publicClient = createMockPublicClient({
      getChainId: async () => 8453, // Mainnet returned instead of testnet!
    });
    const bchClient = createMockBchClient();

    await expect(
      runStartupSelfCheck({
        config,
        publicClient,
        bchClient,
        solverEvmAddress: validEvmAddress,
        solverBchWif: validBchWif,
      }),
    ).rejects.toThrowError(StartupSelfCheckError);
  });

  it('refuses startup if FerryHTLC contract bytecode is missing', async () => {
    const config = createMockConfig();
    const publicClient = createMockPublicClient({
      getBytecode: async ({ address }: { address: string }) => {
        if (address.toLowerCase() === config.baseHtlcAddress.toLowerCase()) {
          return '0x'; // not deployed!
        }
        return dummyBytecode;
      },
    });
    const bchClient = createMockBchClient();

    await expect(
      runStartupSelfCheck({
        config,
        publicClient,
        bchClient,
        solverEvmAddress: validEvmAddress,
        solverBchWif: validBchWif,
      }),
    ).rejects.toThrowError(
      /FerryHTLC contract bytecode missing or empty at address/,
    );
  });

  it('refuses startup if USDC contract bytecode is missing', async () => {
    const config = createMockConfig();
    const publicClient = createMockPublicClient({
      getBytecode: async ({ address }: { address: string }) => {
        if (address.toLowerCase() === config.baseUsdcAddress.toLowerCase()) {
          return undefined; // not deployed!
        }
        return dummyBytecode;
      },
    });
    const bchClient = createMockBchClient();

    await expect(
      runStartupSelfCheck({
        config,
        publicClient,
        bchClient,
        solverEvmAddress: validEvmAddress,
        solverBchWif: validBchWif,
      }),
    ).rejects.toThrowError(
      /USDC contract bytecode missing or empty at address/,
    );
  });

  it('refuses startup on BCH Genesis Hash mismatch', async () => {
    const config = createMockConfig({ network: 'testnet' });
    const publicClient = createMockPublicClient();
    const bchClient = createMockBchClient({
      getQuorumStatus: () => ({
        isQuorumHealthy: true,
        quorumTip: 330000,
        genesisHash: EXPECTED_BCH_GENESIS.mainnet, // server returned mainnet genesis on testnet!
      }),
    });

    await expect(
      runStartupSelfCheck({
        config,
        publicClient,
        bchClient,
        solverEvmAddress: validEvmAddress,
        solverBchWif: validBchWif,
      }),
    ).rejects.toThrowError(/BCH Genesis Hash mismatch on chipnet/);
  });

  it('refuses startup on mainnet if operatorToken is missing or shorter than 32 characters', async () => {
    const configWithoutToken = createMockConfig({
      network: 'mainnet',
      baseChainId: 8453,
      operatorToken: 'a'.repeat(32),
    });
    (
      configWithoutToken as unknown as { operatorToken?: string | undefined }
    ).operatorToken = undefined;

    const publicClient = createMockPublicClient({
      getChainId: async () => 8453,
    });
    const bchClient = createMockBchClient({
      getQuorumStatus: () => ({
        isQuorumHealthy: true,
        quorumTip: 900000,
        genesisHash: EXPECTED_BCH_GENESIS.mainnet,
      }),
    });

    await expect(
      runStartupSelfCheck({
        config: configWithoutToken,
        publicClient,
        bchClient,
        solverEvmAddress: validEvmAddress,
        solverBchWif: validBchWif,
      }),
    ).rejects.toThrowError(
      /OPERATOR_TOKEN with at least 32 characters is required on mainnet/,
    );

    (
      configWithoutToken as unknown as { operatorToken?: string }
    ).operatorToken = 'too-short';
    await expect(
      runStartupSelfCheck({
        config: configWithoutToken,
        publicClient,
        bchClient,
        solverEvmAddress: validEvmAddress,
        solverBchWif: validBchWif,
      }),
    ).rejects.toThrowError(
      /OPERATOR_TOKEN with at least 32 characters is required on mainnet/,
    );
  });
});
