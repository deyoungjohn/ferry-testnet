import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import {
  BchQuorumClient,
  BCH_GENESIS_HASHES,
} from '../src/bch/quorum-client.js';

describe('BCH Fulcrum Genesis Hash Verification', () => {
  let wss: WebSocketServer | null = null;
  let activeClients: BchQuorumClient[] = [];

  afterEach(async () => {
    for (const client of activeClients) {
      client.close();
    }
    activeClients = [];
    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
  });

  function startMockFulcrum(genesisHash: string | null): Promise<string> {
    return new Promise((resolve) => {
      wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => {
        const address = wss!.address();
        const port =
          typeof address === 'object' && address !== null ? address.port : 0;
        resolve(`ws://127.0.0.1:${port}`);
      });

      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          try {
            const req = JSON.parse(data.toString());
            if (req.method === 'blockchain.headers.subscribe') {
              ws.send(
                JSON.stringify({
                  id: req.id,
                  jsonrpc: '2.0',
                  result: { height: 330000, hex: '00' },
                }),
              );
            } else if (req.method === 'server.features') {
              const result: Record<string, unknown> = {
                server_version: 'MockFulcrum 1.0',
                protocol_min: '1.4',
                protocol_max: '1.6',
              };
              if (genesisHash !== null) {
                result.genesis_hash = genesisHash;
              }
              ws.send(
                JSON.stringify({
                  id: req.id,
                  jsonrpc: '2.0',
                  result,
                }),
              );
            } else {
              ws.send(
                JSON.stringify({
                  id: req.id,
                  jsonrpc: '2.0',
                  result: null,
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

  it('refuses to start when configured for chipnet but server returns mainnet genesis', async () => {
    const url = await startMockFulcrum(BCH_GENESIS_HASHES.mainnet);
    const client = new BchQuorumClient([url], 'chipnet');
    activeClients.push(client);

    await expect(client.connect()).rejects.toThrow(
      /returned genesis hash 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f, expected 000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b for network chipnet/,
    );
  });

  it('accepts server when configured for mainnet and server returns mainnet genesis', async () => {
    const url = await startMockFulcrum(BCH_GENESIS_HASHES.mainnet);
    const client = new BchQuorumClient([url], 'mainnet');
    activeClients.push(client);

    await expect(client.connect()).resolves.not.toThrow();
  });

  it('accepts server when configured for chipnet and server returns chipnet genesis', async () => {
    const url = await startMockFulcrum(BCH_GENESIS_HASHES.chipnet);
    const client = new BchQuorumClient([url], 'chipnet');
    activeClients.push(client);

    await expect(client.connect()).resolves.not.toThrow();
  });

  it('refuses to start when configured for mainnet but server returns chipnet genesis', async () => {
    const url = await startMockFulcrum(BCH_GENESIS_HASHES.chipnet);
    const client = new BchQuorumClient([url], 'mainnet');
    activeClients.push(client);

    await expect(client.connect()).rejects.toThrow(
      /returned genesis hash 000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b, expected 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f for network mainnet/,
    );
  });

  it('refuses to start when server.features omits genesis_hash', async () => {
    const url = await startMockFulcrum(null);
    const client = new BchQuorumClient([url], 'chipnet');
    activeClients.push(client);

    await expect(client.connect()).rejects.toThrow(
      /failed genesis verification: server\.features missing genesis_hash/,
    );
  });
});
