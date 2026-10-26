import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import { buildServer, evaluateBchHealth } from '../src/api/server.js';
import {
  SingleFulcrumClient,
  BchQuorumClient,
} from '../src/bch/quorum-client.js';
import { SolverDatabase } from '../src/db/database.js';
import { SolverEngine } from '../src/engine/runner.js';
import { SolverConfigSchema } from '../src/config.js';
import type { BchQuorumStatus } from '../src/bch/types.js';

describe('BCH Tip Liveness vs Block Age', () => {
  describe('evaluateBchHealth unit tests', () => {
    it('allows quoting on testnet when chain is slow but node is live', () => {
      const quorum: BchQuorumStatus = {
        quorumTip: 329556,
        tips: { 'wss://node1': 329556, 'wss://node2': 329556 },
        isQuorumHealthy: true,
        ageSeconds: 23492, // ~6.5 hours since last block
        lastConfirmedAt: Date.now() - 5000, // node answered 5 seconds ago
        livenessAgeSeconds: 5,
        isLivenessHealthy: true,
      };

      const result = evaluateBchHealth(quorum, {
        network: 'testnet',
        tipMaxAgeBchSeconds: 7200,
      });

      expect(result.isHealthy).toBe(true);
      expect(result.stale).toBe(false);
    });

    it('flags stale and disables quoting on testnet when node stops answering (liveness timeout)', () => {
      const quorum: BchQuorumStatus = {
        quorumTip: 329556,
        tips: { 'wss://node1': 329556 },
        isQuorumHealthy: true,
        ageSeconds: 120,
        lastConfirmedAt: Date.now() - 95000, // 95 seconds ago (> 60s window)
        livenessAgeSeconds: 95,
        isLivenessHealthy: false,
      };

      const result = evaluateBchHealth(quorum, {
        network: 'testnet',
        tipMaxAgeBchSeconds: 7200,
      });

      expect(result.isHealthy).toBe(false);
      expect(result.stale).toBe(true);
    });

    it('flags stale and disables quoting when nodes disagree on quorum', () => {
      const quorum: BchQuorumStatus = {
        quorumTip: 329550,
        tips: { 'wss://node1': 329550, 'wss://node2': 329555 },
        isQuorumHealthy: false, // split tip
        ageSeconds: 60,
        lastConfirmedAt: Date.now() - 2000,
        livenessAgeSeconds: 2,
        isLivenessHealthy: true,
      };

      const result = evaluateBchHealth(quorum, {
        network: 'testnet',
        tipMaxAgeBchSeconds: 7200,
      });

      expect(result.isHealthy).toBe(false);
      expect(result.stale).toBe(true);
    });

    it('flags stale on mainnet when block gap exceeds tipMaxAgeBchSeconds even if node is live', () => {
      const quorum: BchQuorumStatus = {
        quorumTip: 850000,
        tips: { 'wss://node1': 850000, 'wss://node2': 850000 },
        isQuorumHealthy: true,
        ageSeconds: 7500, // > 7200s gap on mainnet
        lastConfirmedAt: Date.now() - 2000,
        livenessAgeSeconds: 2,
        isLivenessHealthy: true,
      };

      const result = evaluateBchHealth(quorum, {
        network: 'mainnet',
        tipMaxAgeBchSeconds: 7200,
      });

      // Mainnet flags long block stall as stale!
      expect(result.isHealthy).toBe(false);
      expect(result.stale).toBe(true);
    });

    it('allows quoting on mainnet when block age is within threshold and node is live', () => {
      const quorum: BchQuorumStatus = {
        quorumTip: 850000,
        tips: { 'wss://node1': 850000, 'wss://node2': 850000 },
        isQuorumHealthy: true,
        ageSeconds: 600, // 10 minutes
        lastConfirmedAt: Date.now() - 2000,
        livenessAgeSeconds: 2,
        isLivenessHealthy: true,
      };

      const result = evaluateBchHealth(quorum, {
        network: 'mainnet',
        tipMaxAgeBchSeconds: 7200,
      });

      expect(result.isHealthy).toBe(true);
      expect(result.stale).toBe(false);
    });
  });

  describe('HTTP endpoint behavior with mocked slow chain and dropped connection', () => {
    let db: SolverDatabase;
    const baseConfig = SolverConfigSchema.parse({
      port: 8798,
      network: 'testnet',
      tipMaxAgeBchSeconds: 7200,
      tipMaxAgeBaseSeconds: 60,
      baseHtlcAddress: '0x1111111111111111111111111111111111111111',
      baseUsdcAddress: '0x2222222222222222222222222222222222222222',
      solverEvmPrivateKey:
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      userBchWif: 'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9',
      solverBchWif: 'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9',
    });

    const fakeEvmAdapter = {
      getTip: vi.fn().mockResolvedValue({ height: 5000000, ageSeconds: 5 }),
    } as unknown as EvmChainAdapter;

    beforeEach(() => {
      db = new SolverDatabase(':memory:');
    });

    it('health returns ok=true and quote succeeds on testnet with slow chain (ageSeconds=23492)', async () => {
      const mockBchClient = {
        getQuorumStatus: vi.fn().mockReturnValue({
          quorumTip: 329556,
          tips: { 'wss://mock': 329556 },
          isQuorumHealthy: true,
          ageSeconds: 23492,
          lastConfirmedAt: Date.now() - 1000,
          livenessAgeSeconds: 1,
          isLivenessHealthy: true,
        }),
      } as unknown as BchQuorumClient;

      const engine = new SolverEngine(
        db,
        fakeEvmAdapter,
        mockBchClient,
        baseConfig.solverEvmPrivateKey as `0x${string}`,
        baseConfig.solverBchWif!,
      );

      const app = buildServer({
        config: baseConfig,
        db,
        engine,
        bchClient: mockBchClient,
        evmAdapter: fakeEvmAdapter,
      });

      // 1. Health check
      const healthRes = await app.inject({
        method: 'GET',
        url: '/v1/health',
      });
      expect(healthRes.statusCode).toBe(200);
      const health = JSON.parse(healthRes.body);
      expect(health.ok).toBe(true);
      expect(health.quoting).toBe(true);
      expect(health.bchTip.stale).toBe(false);
      expect(health.bchTip.height).toBe(329556);
      expect(health.bchTip.ageSeconds).toBe(23492); // informational

      // 2. Quote request
      const quoteRes = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: {
          direction: 'COUNTER_TO_BCH',
          bchToken: 'PUSD',
          counterChain: 'base',
          counterSymbol: 'USDC',
          amountIn: '10000000',
          userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
          userBchLockingBytecode:
            '0x76a914000000000000000000000000000000000000000088ac',
          hashLock:
            '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          lane: 'safe',
        },
      });
      expect(quoteRes.statusCode).toBe(200);
      const quote = JSON.parse(quoteRes.body);
      expect(quote.orderId).toBeDefined();

      await app.close();
    });

    it('health returns ok=false and quote returns 503 when connection is dropped / node stops responding', async () => {
      const mockBchClient = {
        getQuorumStatus: vi.fn().mockReturnValue({
          quorumTip: 329556,
          tips: {},
          isQuorumHealthy: false,
          ageSeconds: Infinity,
          lastConfirmedAt: Date.now() - 120000,
          livenessAgeSeconds: 120,
          isLivenessHealthy: false,
        }),
      } as unknown as BchQuorumClient;

      const engine = new SolverEngine(
        db,
        fakeEvmAdapter,
        mockBchClient,
        baseConfig.solverEvmPrivateKey as `0x${string}`,
        baseConfig.solverBchWif!,
      );

      const app = buildServer({
        config: baseConfig,
        db,
        engine,
        bchClient: mockBchClient,
        evmAdapter: fakeEvmAdapter,
      });

      // 1. Health check
      const healthRes = await app.inject({
        method: 'GET',
        url: '/v1/health',
      });
      expect(healthRes.statusCode).toBe(200);
      const health = JSON.parse(healthRes.body);
      expect(health.ok).toBe(false);
      expect(health.quoting).toBe(false);
      expect(health.bchTip.stale).toBe(true);

      // 2. Quote request returns 503
      const quoteRes = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: {
          direction: 'COUNTER_TO_BCH',
          bchToken: 'PUSD',
          counterChain: 'base',
          counterSymbol: 'USDC',
          amountIn: '10000000',
          userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
          userBchLockingBytecode:
            '0x76a914000000000000000000000000000000000000000088ac',
          hashLock:
            '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          lane: 'safe',
        },
      });
      expect(quoteRes.statusCode).toBe(503);
      const err = JSON.parse(quoteRes.body);
      expect(err.code).toBe('BCH_TIP_UNHEALTHY');

      await app.close();
    });
  });

  describe('SingleFulcrumClient ping round trips', () => {
    let wss: WebSocketServer;
    let port: number;

    beforeEach(async () => {
      port = 8795;
      wss = new WebSocketServer({ port });
    });

    it('sends server.ping and updates lastConfirmedAt', async () => {
      let pingReceived = false;

      wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.method === 'blockchain.headers.subscribe') {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: { height: 320000, hex: '00' },
              }),
            );
          } else if (msg.method === 'server.features') {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  genesis_hash:
                    '000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b',
                },
              }),
            );
          } else if (msg.method === 'server.ping') {
            pingReceived = true;
            ws.send(JSON.stringify({ id: msg.id, result: null }));
          }
        });
      });

      const client = new SingleFulcrumClient(`ws://127.0.0.1:${port}`);
      await client.connect();

      const initialConfirmedAt = client.getLastConfirmedAt();
      expect(initialConfirmedAt).toBeGreaterThan(0);

      // Wait 10ms and trigger ping
      await new Promise((r) => setTimeout(r, 10));
      const pingSuccess = await client.ping();
      expect(pingSuccess).toBe(true);
      expect(pingReceived).toBe(true);
      expect(client.getLastConfirmedAt()).toBeGreaterThanOrEqual(
        initialConfirmedAt,
      );

      client.close();
      await new Promise<void>((r) => wss.close(() => r()));
    });

    it('ping fallback to headers.subscribe does NOT update tipTimestamp if height is unchanged', async () => {
      wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.method === 'blockchain.headers.subscribe') {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: { height: 320000, hex: '00' },
              }),
            );
          } else if (msg.method === 'server.features') {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  genesis_hash:
                    '000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b',
                },
              }),
            );
          } else if (msg.method === 'server.ping') {
            // Simulate server.ping failing or unsupported
            ws.send(
              JSON.stringify({
                id: msg.id,
                error: { code: -32601, message: 'Method not found' },
              }),
            );
          }
        });
      });

      const client = new SingleFulcrumClient(`ws://127.0.0.1:${port}`);
      await client.connect();

      const initialTip = client.getTip();
      expect(initialTip.height).toBe(320000);
      const initialTimestamp = initialTip.timestamp;

      // Wait 20ms and ping (which fails server.ping and falls back to headers.subscribe with same height 320000)
      await new Promise((r) => setTimeout(r, 20));
      const pingSuccess = await client.ping();
      expect(pingSuccess).toBe(true);

      const afterTip = client.getTip();
      // Height unchanged, so tipTimestamp must NOT have been refreshed!
      expect(afterTip.height).toBe(320000);
      expect(afterTip.timestamp).toBe(initialTimestamp);
      // But lastConfirmedAt MUST have been updated
      expect(client.getLastConfirmedAt()).toBeGreaterThanOrEqual(
        initialTimestamp,
      );

      client.close();
      await new Promise<void>((r) => wss.close(() => r()));
    });
  });
});
