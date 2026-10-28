import { describe, it, expect, afterEach, type TestContext } from 'vitest';
import { loadConfigFromEnv, SolverConfigSchema } from '../src/config.js';
import {
  runStartupSelfCheck,
  EXPECTED_BCH_GENESIS,
} from '../src/ops/self-check.js';
import {
  BchQuorumClient,
  BCH_GENESIS_HASHES,
} from '../src/bch/quorum-client.js';
import { SolverEngine } from '../src/engine/runner.js';
import { buildServer } from '../src/api/server.js';
import { SolverDatabase } from '../src/db/database.js';
import { TestnetStubPriceSource } from '../src/pricing/price-source.js';
import { createPublicClient, http } from 'viem';

describe('Solver Mainnet Refusal Paths', () => {
  const throwawayEvmKey =
    '0x1111111111111111111111111111111111111111111111111111111111111111';
  const throwawayEvmAddress =
    '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A' as const;
  const throwawayMainnetBchWif =
    'L5Yjg1HdPVrt1FeGvDR1ApnrJ3Jx6gAtBEWPAMBwquNQh3xaaLB8'; // valid mainnet WIF format
  const validOperatorToken = 'a'.repeat(32);
  const twoFulcrumHosts =
    'wss://bch.imaginary.cash:50004,wss://blackie.c3-soft.com:50004';
  const dummyBytecode =
    '0x608060405234801561001057600080fd5b50610123806100206000396000f3fe' as const;

  const createBaseMainnetConfig = (overrides = {}) =>
    SolverConfigSchema.parse({
      network: 'mainnet',
      baseRpcUrl: 'https://mainnet.base.org',
      baseChainId: 8453,
      baseHtlcAddress: '0x1111111111111111111111111111111111111111',
      baseUsdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      bchElectrumUrls: twoFulcrumHosts,
      solverEvmPrivateKey: throwawayEvmKey,
      solverBchWif: throwawayMainnetBchWif,
      operatorToken: validOperatorToken,
      ...overrides,
    });

  const createMockPublicClient = (overrides = {}) => ({
    getChainId: async () => 8453,
    getBytecode: async () => dummyBytecode,
    getBalance: async () => 50000000000000000n, // 0.05 ETH
    readContract: async () => 100000000n, // 100.00 USDC
    ...overrides,
  });

  const createMockBchClient = (overrides = {}) => ({
    getQuorumStatus: () => ({
      isQuorumHealthy: true,
      quorumTip: 900000,
      genesisHash: EXPECTED_BCH_GENESIS.mainnet,
    }),
    listUnspent: async () => [
      {
        value: 5000000,
        token: {
          category:
            'ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac',
          amount: 100000000n,
        },
      },
    ],
    ...overrides,
  });

  afterEach(() => {
    delete process.env.FAULT_CRASH_POINT;
    delete process.env.FERRY_FAULT_INJECTION;
  });

  // --------------------------------------------------------------------------
  // Refusal Path 1: missing OPERATOR_TOKEN
  // --------------------------------------------------------------------------
  it('1. Refusal: missing or short OPERATOR_TOKEN on mainnet', async () => {
    // 1a. Missing in config
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        SOLVER_EVM_PRIVATE_KEY: throwawayEvmKey,
        BCH_ELECTRUM_URLS: twoFulcrumHosts,
      }),
    ).toThrowError(
      /OPERATOR_TOKEN with at least 32 characters is required on mainnet/,
    );

    // 1b. Short token in config
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        SOLVER_EVM_PRIVATE_KEY: throwawayEvmKey,
        BCH_ELECTRUM_URLS: twoFulcrumHosts,
        OPERATOR_TOKEN: 'short-token-under-32-chars',
      }),
    ).toThrowError(
      /OPERATOR_TOKEN with at least 32 characters is required on mainnet/,
    );

    // 1c. In self-check
    const config = createBaseMainnetConfig();
    delete (config as unknown as Record<string, unknown>).operatorToken;
    await expect(
      runStartupSelfCheck({
        config,
        publicClient: createMockPublicClient(),
        bchClient: createMockBchClient(),
        solverEvmAddress: throwawayEvmAddress,
        solverBchWif: throwawayMainnetBchWif,
      }),
    ).rejects.toThrowError(
      /OPERATOR_TOKEN with at least 32 characters is required on mainnet/,
    );
  });

  // --------------------------------------------------------------------------
  // Refusal Path 2: dev key
  // --------------------------------------------------------------------------
  it('2. Refusal: dev key, known testnet key, ALLOW_DEV_KEYS, or testnet WIF on mainnet', () => {
    // 2a. Anvil default dev key (0x59c6...)
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        OPERATOR_TOKEN: validOperatorToken,
        BCH_ELECTRUM_URLS: twoFulcrumHosts,
        SOLVER_EVM_PRIVATE_KEY:
          '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      }),
    ).toThrowError(/Default dev private key cannot be used on mainnet/);

    // 2b. Anvil account 0 key (0xac09...)
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        OPERATOR_TOKEN: validOperatorToken,
        BCH_ELECTRUM_URLS: twoFulcrumHosts,
        SOLVER_EVM_PRIVATE_KEY:
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      }),
    ).toThrowError(/Default dev private key cannot be used on mainnet/);

    // 2c. ALLOW_DEV_KEYS flag on mainnet
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        OPERATOR_TOKEN: validOperatorToken,
        BCH_ELECTRUM_URLS: twoFulcrumHosts,
        SOLVER_EVM_PRIVATE_KEY: throwawayEvmKey,
        ALLOW_DEV_KEYS: '1',
      }),
    ).toThrowError(
      /ALLOW_DEV_KEYS is not permitted on mainnet. Refusing to start./,
    );

    // 2d. Testnet BCH WIF (starts with 'c') on mainnet
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        OPERATOR_TOKEN: validOperatorToken,
        BCH_ELECTRUM_URLS: twoFulcrumHosts,
        SOLVER_EVM_PRIVATE_KEY: throwawayEvmKey,
        SOLVER_BCH_WIF: 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA',
      }),
    ).toThrowError(
      /Testnet BCH WIF cannot be used on mainnet. Refusing to start./,
    );
  });

  // --------------------------------------------------------------------------
  // Refusal Path 3: fault injection variable
  // --------------------------------------------------------------------------
  it('3. Refusal: fault injection variables on mainnet', () => {
    // 3a. In loadConfigFromEnv with FAULT_CRASH_POINT
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        OPERATOR_TOKEN: validOperatorToken,
        BCH_ELECTRUM_URLS: twoFulcrumHosts,
        SOLVER_EVM_PRIVATE_KEY: throwawayEvmKey,
        FAULT_CRASH_POINT: 'BEFORE_BCH_LOCK_BROADCAST',
      }),
    ).toThrowError(
      /Fault injection variables \(FERRY_FAULT_INJECTION \/ FAULT_CRASH_POINT\) are not allowed on mainnet/,
    );

    // 3b. In loadConfigFromEnv with FERRY_FAULT_INJECTION
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        OPERATOR_TOKEN: validOperatorToken,
        BCH_ELECTRUM_URLS: twoFulcrumHosts,
        SOLVER_EVM_PRIVATE_KEY: throwawayEvmKey,
        FERRY_FAULT_INJECTION: '1',
      }),
    ).toThrowError(
      /Fault injection variables \(FERRY_FAULT_INJECTION \/ FAULT_CRASH_POINT\) are not allowed on mainnet/,
    );

    // 3c. In SolverEngine instantiation
    process.env.FAULT_CRASH_POINT = 'BEFORE_BCH_LOCK_BROADCAST';
    const mockDb = { getOrder: () => null } as unknown as SolverDatabase;
    expect(() => {
      new SolverEngine(
        mockDb,
        {} as never,
        {} as never,
        throwawayEvmKey as `0x${string}`,
        throwawayMainnetBchWif,
        'mainnet',
      );
    }).toThrowError(
      /Refusing to start: FAULT_CRASH_POINT is not allowed when network is mainnet/,
    );
  });

  // --------------------------------------------------------------------------
  // Refusal Path 4: trustedProxy mismatch
  // --------------------------------------------------------------------------
  it('4. Refusal: trustedProxy mismatch on mainnet rejects forwarding headers with 400 UNTRUSTED_PROXY_HEADER', async () => {
    const config = createBaseMainnetConfig({ trustedProxy: false });
    const db = new SolverDatabase(':memory:');
    const app = buildServer({
      config,
      db,
      evmAdapter: {
        getTip: async () => ({ height: 1000, ageSeconds: 1, stale: false }),
        getLock: async () => null,
      } as never,
      bchClient: {
        getQuorumStatus: () => ({
          isQuorumHealthy: true,
          quorumTip: 900000,
          ageSeconds: 5,
        }),
      } as never,
      engine: { submitSecret: async () => {} } as never,
      priceSource: new TestnetStubPriceSource(),
    });

    // Request arrives with X-Forwarded-For header on mainnet when trustedProxy is false
    const response = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      headers: {
        'x-forwarded-for': '203.0.113.195',
      },
      payload: {
        direction: 'COUNTER_TO_BCH',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '10000000',
        userCounterAddress: throwawayEvmAddress,
        userBchLockingBytecode:
          '0x76a914111111111111111111111111111111111111111188ac',
        hashLock:
          '0x2222222222222222222222222222222222222222222222222222222222222222',
        lane: 'safe',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('UNTRUSTED_PROXY_HEADER');
    expect(body.message).toContain(
      'Forwarding headers (X-Forwarded-For / X-Real-IP) are rejected on mainnet when TRUSTED_PROXY is disabled',
    );

    db.close();
  });

  // --------------------------------------------------------------------------
  // Refusal Path 5: one Fulcrum host instead of two
  // --------------------------------------------------------------------------
  it('5. Refusal: one Fulcrum host instead of two on mainnet', async () => {
    // 5a. Single URL in loadConfigFromEnv
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        OPERATOR_TOKEN: validOperatorToken,
        BCH_ELECTRUM_URLS: 'wss://bch.imaginary.cash:50004',
        SOLVER_EVM_PRIVATE_KEY: throwawayEvmKey,
      }),
    ).toThrowError(
      /At least two independent Fulcrum hosts are required on mainnet \(configured: 1\)/,
    );

    // 5b. Duplicate URLs (same host) in loadConfigFromEnv
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        OPERATOR_TOKEN: validOperatorToken,
        BCH_ELECTRUM_URLS:
          'wss://bch.imaginary.cash:50004,wss://bch.imaginary.cash:50004',
        SOLVER_EVM_PRIVATE_KEY: throwawayEvmKey,
      }),
    ).toThrowError(
      /At least two independent Fulcrum hosts are required on mainnet \(configured: 1\)/,
    );

    // 5c. Single host in self-check
    const configSingleHost = {
      ...createBaseMainnetConfig(),
      bchElectrumUrls: 'wss://bch.imaginary.cash:50004',
    };
    await expect(
      runStartupSelfCheck({
        config: configSingleHost,
        publicClient: createMockPublicClient(),
        bchClient: createMockBchClient(),
        solverEvmAddress: throwawayEvmAddress,
        solverBchWif: throwawayMainnetBchWif,
      }),
    ).rejects.toThrowError(
      /At least two independent Fulcrum hosts are required on mainnet \(configured: 1\)/,
    );
  });

  // --------------------------------------------------------------------------
  // Refusal Path 6: a Fulcrum host with the wrong genesis
  // --------------------------------------------------------------------------
  it('6. Refusal: a Fulcrum host with the wrong genesis hash', async () => {
    // 6a. Quorum client genesis verification against chipnet genesis on mainnet
    const fakeClient = {
      isConnected: () => true,
      getGenesisHash: () => BCH_GENESIS_HASHES.chipnet, // Returned chipnet instead of mainnet!
      fetchFeatures: async () => ({
        genesis_hash: BCH_GENESIS_HASHES.chipnet,
      }),
      url: 'wss://wrong-node.example.com:50004',
    };
    const bchQuorum = new BchQuorumClient(
      ['wss://wrong-node.example.com:50004'],
      'mainnet',
    );
    (bchQuorum as unknown as { clients: unknown[] }).clients = [fakeClient];

    await expect(bchQuorum.verifyGenesis('mainnet')).rejects.toThrowError(
      /returned genesis hash 000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b, expected 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f for network mainnet/,
    );

    // 6b. In self-check
    const config = createBaseMainnetConfig();
    const bchClientWithWrongGenesis = createMockBchClient({
      getQuorumStatus: () => ({
        isQuorumHealthy: true,
        quorumTip: 900000,
        genesisHash: EXPECTED_BCH_GENESIS.chipnet,
      }),
    });

    await expect(
      runStartupSelfCheck({
        config,
        publicClient: createMockPublicClient(),
        bchClient: bchClientWithWrongGenesis,
        solverEvmAddress: throwawayEvmAddress,
        solverBchWif: throwawayMainnetBchWif,
      }),
    ).rejects.toThrowError(/BCH Genesis Hash mismatch on mainnet/);
  });

  // --------------------------------------------------------------------------
  // Refusal Path 7: a Base RPC with the wrong chain id
  // --------------------------------------------------------------------------
  it('7. Refusal: a Base RPC with the wrong chain id (e.g. 84532 instead of 8453)', async () => {
    const config = createBaseMainnetConfig({ baseChainId: 8453 });
    const publicClientWrongChain = createMockPublicClient({
      getChainId: async () => 84532, // Base Sepolia returned on mainnet!
    });

    await expect(
      runStartupSelfCheck({
        config,
        publicClient: publicClientWrongChain,
        bchClient: createMockBchClient(),
        solverEvmAddress: throwawayEvmAddress,
        solverBchWif: throwawayMainnetBchWif,
      }),
    ).rejects.toThrowError(
      /EVM Chain ID mismatch: RPC returned 84532, expected 8453/,
    );
  });

  // --------------------------------------------------------------------------
  // Refusal Path 8: an HTLC address with the wrong code hash
  // --------------------------------------------------------------------------
  it('8. Refusal: an HTLC address with the wrong code hash or missing bytecode', async () => {
    // 8a. Bytecode missing (contract not deployed)
    const config = createBaseMainnetConfig();
    const publicClientMissingBytecode = createMockPublicClient({
      getBytecode: async () => '0x',
    });

    await expect(
      runStartupSelfCheck({
        config,
        publicClient: publicClientMissingBytecode,
        bchClient: createMockBchClient(),
        solverEvmAddress: throwawayEvmAddress,
        solverBchWif: throwawayMainnetBchWif,
      }),
    ).rejects.toThrowError(
      /FerryHTLC contract bytecode missing or empty at address/,
    );

    // 8b. Bytecode code hash mismatch against expected code hash
    const expectedHash =
      '0x684ed535a307fb57a0ee587c1421b9534a19138e2d18f8f91ab8ad3bc069440d';
    const configWithExpectedHash = createBaseMainnetConfig({
      expectedHtlcCodeHash: expectedHash,
    });
    const publicClientTampered = createMockPublicClient({
      getBytecode: async () => '0x6001600101', // different bytecode -> different hash
    });

    await expect(
      runStartupSelfCheck({
        config: configWithExpectedHash,
        publicClient: publicClientTampered,
        bchClient: createMockBchClient(),
        solverEvmAddress: throwawayEvmAddress,
        solverBchWif: throwawayMainnetBchWif,
      }),
    ).rejects.toThrowError(/FerryHTLC contract code hash mismatch at address/);
  });

  // --------------------------------------------------------------------------
  // Refusal Path 9: an empty inventory
  // --------------------------------------------------------------------------
  it('9. Refusal: an empty inventory on mainnet', async () => {
    const config = createBaseMainnetConfig();

    // 9a. Zero native ETH (no gas to execute locks or claims)
    const clientZeroGas = createMockPublicClient({
      getBalance: async () => 0n,
    });
    await expect(
      runStartupSelfCheck({
        config,
        publicClient: clientZeroGas,
        bchClient: createMockBchClient(),
        solverEvmAddress: throwawayEvmAddress,
        solverBchWif: throwawayMainnetBchWif,
      }),
    ).rejects.toThrowError(
      /Empty solver inventory on mainnet: hot wallet has insufficient liquid balance to operate \(EVM native gas: 0 wei/,
    );

    // 9b. Zero BCH sats (no mining fees or carry sats)
    const bchClientZeroSats = createMockBchClient({
      listUnspent: async () => [],
    });
    await expect(
      runStartupSelfCheck({
        config,
        publicClient: createMockPublicClient(),
        bchClient: bchClientZeroSats,
        solverEvmAddress: throwawayEvmAddress,
        solverBchWif: throwawayMainnetBchWif,
      }),
    ).rejects.toThrowError(
      /Empty solver inventory on mainnet: hot wallet has insufficient liquid balance to operate .* BCH: 0 sats/,
    );

    // 9c. Zero swap token liquidity (0 USDC and 0 BCH tokens)
    const clientZeroTokens = createMockPublicClient({
      readContract: async () => 0n, // 0 USDC
    });
    const bchClientZeroTokens = createMockBchClient({
      listUnspent: async () => [{ value: 5000000 }], // has sats, but 0 tokens
    });
    await expect(
      runStartupSelfCheck({
        config,
        publicClient: clientZeroTokens,
        bchClient: bchClientZeroTokens,
        solverEvmAddress: throwawayEvmAddress,
        solverBchWif: throwawayMainnetBchWif,
      }),
    ).rejects.toThrowError(
      /Empty solver inventory on mainnet: hot wallet has insufficient liquid balance to operate.*Base USDC: 0.*BCH tokens: 0/,
    );
  });

  // --------------------------------------------------------------------------
  // Refusal Path 10: ALLOW_MOCK_PAYLINK_SIGNATURES set
  // --------------------------------------------------------------------------
  it('10. Refusal: ALLOW_MOCK_PAYLINK_SIGNATURES set on mainnet', () => {
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        OPERATOR_TOKEN: validOperatorToken,
        BCH_ELECTRUM_URLS: twoFulcrumHosts,
        SOLVER_EVM_PRIVATE_KEY: throwawayEvmKey,
        ALLOW_MOCK_PAYLINK_SIGNATURES: '1',
      }),
    ).toThrowError(
      /ALLOW_MOCK_PAYLINK_SIGNATURES is not permitted on mainnet; real BCH signed messages required/,
    );
  });

  // --------------------------------------------------------------------------
  // Live Read-Only Public Mainnet Verification (Opt-in via FERRY_LIVE_TESTS=1)
  // --------------------------------------------------------------------------
  it(
    'Live Proof: starting against real read-only public mainnet endpoints with throwaway key rejects on empty inventory',
    { timeout: 30_000 },
    async (ctx: TestContext) => {
      if (process.env.FERRY_LIVE_TESTS !== '1') {
        console.log(
          'Skipping live mainnet read-only verification: opt-in by setting FERRY_LIVE_TESTS=1',
        );
        ctx.skip();
        return;
      }

      // 1. Connect real read-only public clients with proper timeouts
      const realBasePublicClient = createPublicClient({
        transport: http('https://mainnet.base.org', {
          timeout: 20_000,
          retryCount: 2,
        }),
      });

      const chainId = await realBasePublicClient.getChainId();
      expect(chainId).toBe(8453);

      // 2. Query real Base USDC token code
      const usdcBytecode = await realBasePublicClient.getBytecode({
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      });
      expect(usdcBytecode).toBeDefined();
      expect(usdcBytecode!.length).toBeGreaterThan(10);

      // 3. Connect real read-only BCH Fulcrum client
      const bchQuorum = new BchQuorumClient(
        ['wss://bch.imaginary.cash:50004', 'wss://blackie.c3-soft.com:50004'],
        'mainnet',
      );
      try {
        await bchQuorum.connect();
        const quorumStatus = bchQuorum.getQuorumStatus();
        expect(quorumStatus.quorumTip).toBeGreaterThan(800000);
        expect(bchQuorum.expectedNetwork).toBe('mainnet');

        // 4. Run startup self-check with throwaway key:
        // It verifies genesis, verifies chainId 8453, verifies USDC bytecode, and refuses startup
        // because the throwaway address has zero inventory!
        const liveConfig = SolverConfigSchema.parse({
          network: 'mainnet',
          baseRpcUrl: 'https://mainnet.base.org',
          baseChainId: 8453,
          baseHtlcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // point to deployed code
          baseUsdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          bchElectrumUrls: twoFulcrumHosts,
          solverEvmPrivateKey: throwawayEvmKey,
          solverBchWif: throwawayMainnetBchWif,
          operatorToken: validOperatorToken,
        });

        await expect(
          runStartupSelfCheck({
            config: liveConfig,
            publicClient: realBasePublicClient,
            bchClient: bchQuorum,
            solverEvmAddress: throwawayEvmAddress,
            solverBchWif: throwawayMainnetBchWif,
          }),
        ).rejects.toThrowError(/Empty solver inventory on mainnet/);
      } finally {
        bchQuorum.close();
      }
    },
  );
});
