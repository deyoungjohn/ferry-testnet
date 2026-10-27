import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  verifyFulcrumQuorum,
  BCH_GENESIS_HASHES,
} from './verify-fulcrum-quorum.js';

describe('verify-fulcrum-quorum script', () => {
  let servers: WebSocketServer[] = [];

  afterEach(async () => {
    for (const server of servers) {
      await new Promise<void>((res) => server.close(() => res()));
    }
    servers = [];
  });

  function createMockServer(
    height: number,
    genesisHash: string | null,
  ): Promise<string> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => {
        const address = wss.address();
        const port =
          typeof address === 'object' && address !== null ? address.port : 0;
        servers.push(wss);
        resolve(`ws://127.0.0.1:${port}`);
      });

      wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
          try {
            const req = JSON.parse(raw.toString());
            if (req.method === 'blockchain.headers.subscribe') {
              ws.send(
                JSON.stringify({
                  id: req.id,
                  jsonrpc: '2.0',
                  result: { height, hex: '00' },
                }),
              );
            } else if (req.method === 'server.features') {
              const res: Record<string, unknown> = {
                server_version: 'MockFulcrum 1.0',
              };
              if (genesisHash !== null) {
                res.genesis_hash = genesisHash;
              }
              ws.send(
                JSON.stringify({
                  id: req.id,
                  jsonrpc: '2.0',
                  result: res,
                }),
              );
            }
          } catch {
            // ignore
          }
        });
      });
    });
  }

  it('passes when both nodes return matching genesis hash and height within skew tolerance', async () => {
    const s1 = await createMockServer(850000, BCH_GENESIS_HASHES.mainnet);
    const s2 = await createMockServer(850001, BCH_GENESIS_HASHES.mainnet);

    const report = await verifyFulcrumQuorum({
      network: 'mainnet',
      endpoints: [s1, s2],
      maxSkew: 1,
      timeoutMs: 2000,
    });

    expect(report.passed).toBe(true);
    expect(report.heightSkew).toBe(1);
    expect(report.failureReasons).toHaveLength(0);
  });

  it('fails when a node returns wrong genesis hash', async () => {
    const s1 = await createMockServer(850000, BCH_GENESIS_HASHES.mainnet);
    const s2 = await createMockServer(850000, BCH_GENESIS_HASHES.chipnet);

    const report = await verifyFulcrumQuorum({
      network: 'mainnet',
      endpoints: [s1, s2],
      maxSkew: 1,
      timeoutMs: 2000,
    });

    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((r) => r.includes('genesis hash mismatch')),
    ).toBe(true);
  });

  it('fails when node height skew exceeds tolerance', async () => {
    const s1 = await createMockServer(850000, BCH_GENESIS_HASHES.mainnet);
    const s2 = await createMockServer(850005, BCH_GENESIS_HASHES.mainnet);

    const report = await verifyFulcrumQuorum({
      network: 'mainnet',
      endpoints: [s1, s2],
      maxSkew: 1,
      timeoutMs: 2000,
    });

    expect(report.passed).toBe(false);
    expect(report.failureReasons.some((r) => r.includes('divergence'))).toBe(
      true,
    );
    expect(report.heightSkew).toBe(5);
  });

  it('fails when a node is unreachable', async () => {
    const s1 = await createMockServer(850000, BCH_GENESIS_HASHES.mainnet);
    const badUrl = 'ws://127.0.0.1:54321'; // Closed port

    const report = await verifyFulcrumQuorum({
      network: 'mainnet',
      endpoints: [s1, badUrl],
      maxSkew: 1,
      timeoutMs: 1000,
    });

    expect(report.passed).toBe(false);
    expect(
      report.failureReasons.some((r) => r.includes('failed to connect')),
    ).toBe(true);
  });
});
