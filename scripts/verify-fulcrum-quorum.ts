import WebSocket, { WebSocketServer } from 'ws';

export const BCH_GENESIS_HASHES = {
  mainnet: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  chipnet: '000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b',
} as const;

export const DEFAULT_FULCRUM_ENDPOINTS = {
  mainnet: [
    'wss://blackie.c3-soft.com:50004',
    'wss://bch.imaginary.cash:50004',
  ],
  chipnet: [
    'wss://chipnet.c3-soft.com:50004',
    'wss://chipnet.imaginary.cash:50004',
  ],
} as const;

export interface NodeQuorumResult {
  url: string;
  connected: boolean;
  genesisHash: string | null;
  height: number;
  error?: string | undefined;
}

export interface QuorumVerificationReport {
  network: 'mainnet' | 'chipnet';
  expectedGenesis: string;
  nodes: NodeQuorumResult[];
  heightSkew: number;
  passed: boolean;
  failureReasons: string[];
}

export async function queryFulcrumNode(
  url: string,
  timeoutMs = 8000,
): Promise<NodeQuorumResult> {
  return new Promise<NodeQuorumResult>((resolve) => {
    let finished = false;
    let ws: WebSocket | null = null;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        if (ws) {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
        }
        resolve({
          url,
          connected: false,
          genesisHash: null,
          height: 0,
          error: `Connection timeout after ${timeoutMs}ms`,
        });
      }
    }, timeoutMs);

    try {
      ws = new WebSocket(url);
    } catch (err) {
      clearTimeout(timer);
      resolve({
        url,
        connected: false,
        genesisHash: null,
        height: 0,
        error: (err as Error).message,
      });
      return;
    }

    let genesisHash: string | null = null;
    let height = 0;
    let receivedFeatures = false;
    let receivedHeader = false;

    const maybeFinish = () => {
      if (receivedFeatures && receivedHeader && !finished) {
        finished = true;
        clearTimeout(timer);
        try {
          ws?.close();
        } catch {
          // ignore
        }
        resolve({
          url,
          connected: true,
          genesisHash,
          height,
        });
      }
    };

    ws.on('open', () => {
      // 1. Subscribe to headers
      ws!.send(
        JSON.stringify({
          id: 1,
          method: 'blockchain.headers.subscribe',
          params: [],
        }),
      );
      // 2. Fetch server features
      ws!.send(
        JSON.stringify({
          id: 2,
          method: 'server.features',
          params: [],
        }),
      );
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id === 1 && msg.result) {
          height = msg.result.height ?? 0;
          receivedHeader = true;
          maybeFinish();
        } else if (msg.id === 2 && msg.result) {
          genesisHash = msg.result.genesis_hash ?? null;
          receivedFeatures = true;
          maybeFinish();
        } else if (
          msg.method === 'blockchain.headers.subscribe' &&
          msg.params?.[0]
        ) {
          height = msg.params[0].height ?? height;
          receivedHeader = true;
          maybeFinish();
        }
      } catch {
        // Parse error
      }
    });

    ws.on('error', (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({
          url,
          connected: false,
          genesisHash: null,
          height: 0,
          error: err.message,
        });
      }
    });

    ws.on('close', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({
          url,
          connected: receivedFeatures || receivedHeader,
          genesisHash,
          height,
          error:
            receivedFeatures && receivedHeader
              ? undefined
              : 'Connection closed prematurely',
        });
      }
    });
  });
}

export async function verifyFulcrumQuorum(options: {
  network?: 'mainnet' | 'chipnet';
  endpoints?: string[];
  maxSkew?: number;
  timeoutMs?: number;
}): Promise<QuorumVerificationReport> {
  const network = options.network ?? 'mainnet';
  const expectedGenesis = BCH_GENESIS_HASHES[network];
  const endpoints =
    options.endpoints ?? Array.from(DEFAULT_FULCRUM_ENDPOINTS[network]);
  const maxSkew = options.maxSkew ?? 1;
  const timeoutMs = options.timeoutMs ?? 8000;

  const nodeResults = await Promise.all(
    endpoints.map((ep) => queryFulcrumNode(ep, timeoutMs)),
  );

  const failureReasons: string[] = [];
  let minHeight = Infinity;
  let maxHeight = 0;

  for (const node of nodeResults) {
    if (!node.connected) {
      failureReasons.push(`Node ${node.url} failed to connect: ${node.error}`);
      continue;
    }
    if (!node.genesisHash) {
      failureReasons.push(`Node ${node.url} did not provide a genesis hash`);
      continue;
    }
    if (node.genesisHash.toLowerCase() !== expectedGenesis.toLowerCase()) {
      failureReasons.push(
        `Node ${node.url} genesis hash mismatch: got ${node.genesisHash}, expected ${expectedGenesis} (${network})`,
      );
    }
    if (node.height < minHeight) minHeight = node.height;
    if (node.height > maxHeight) maxHeight = node.height;
  }

  const heightSkew =
    nodeResults.length > 0 && minHeight !== Infinity
      ? maxHeight - minHeight
      : 0;

  if (nodeResults.filter((n) => n.connected).length < endpoints.length) {
    failureReasons.push(
      `Quorum incomplete: ${nodeResults.filter((n) => n.connected).length}/${endpoints.length} nodes connected`,
    );
  } else if (heightSkew > maxSkew) {
    failureReasons.push(
      `Quorum block height divergence: skew is ${heightSkew} blocks (max allowed: ${maxSkew})`,
    );
  }

  return {
    network,
    expectedGenesis,
    nodes: nodeResults,
    heightSkew,
    passed: failureReasons.length === 0,
    failureReasons,
  };
}

// CLI entry point
if (process.argv[1]?.endsWith('verify-fulcrum-quorum.ts')) {
  const isMock =
    process.argv.includes('--mock') || process.argv.includes('--offline');
  const networkArg = process.argv.includes('--network')
    ? process.argv[process.argv.indexOf('--network') + 1]
    : process.env.BCH_NETWORK || 'mainnet';
  const network = networkArg === 'chipnet' ? 'chipnet' : 'mainnet';

  (async () => {
    console.log(
      `[Fulcrum Quorum] Verifying ${network} Fulcrum consensus (Genesis & Block Height)...`,
    );

    if (isMock) {
      console.log('[Fulcrum Quorum] Running in offline mock mode');
      const expectedGenesis = BCH_GENESIS_HASHES[network];
      const servers: WebSocketServer[] = [];
      const mockUrls: string[] = [];

      for (let i = 0; i < 2; i++) {
        const height = 800000 + i;
        const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        await new Promise<void>((res) => wss.on('listening', () => res()));
        const port = (wss.address() as { port: number }).port;
        mockUrls.push(`ws://127.0.0.1:${port}`);
        wss.on('connection', (ws) => {
          ws.on('message', (data) => {
            try {
              const req = JSON.parse(data.toString());
              if (req.method === 'blockchain.headers.subscribe') {
                ws.send(
                  JSON.stringify({
                    id: req.id,
                    jsonrpc: '2.0',
                    result: { height, hex: '00' },
                  }),
                );
              } else if (req.method === 'server.features') {
                ws.send(
                  JSON.stringify({
                    id: req.id,
                    jsonrpc: '2.0',
                    result: {
                      genesis_hash: expectedGenesis,
                      server_version: 'MockFulcrum 1.0',
                    },
                  }),
                );
              }
            } catch {
              // ignore
            }
          });
        });
        servers.push(wss);
      }

      const report = await verifyFulcrumQuorum({
        network,
        endpoints: mockUrls,
      });

      for (const s of servers) {
        s.close();
      }

      console.log(`[Fulcrum Quorum] Report:`);
      console.log(`  Network: ${report.network}`);
      console.log(`  Expected Genesis: ${report.expectedGenesis}`);
      console.log(`  Height Skew: ${report.heightSkew}`);
      for (const node of report.nodes) {
        console.log(
          `  Node ${node.url}: Height ${node.height}, Genesis ${node.genesisHash}`,
        );
      }
      if (report.passed) {
        console.log('✅ Fulcrum Quorum Verified Successfully');
        process.exit(0);
      } else {
        console.error('❌ Fulcrum Quorum Verification Failed:');
        for (const err of report.failureReasons) {
          console.error(`  - ${err}`);
        }
        process.exit(1);
      }
    } else {
      const report = await verifyFulcrumQuorum({ network });
      console.log(`[Fulcrum Quorum] Verification Result:`);
      console.log(`  Network: ${report.network}`);
      console.log(`  Expected Genesis: ${report.expectedGenesis}`);
      console.log(`  Height Skew: ${report.heightSkew}`);
      for (const node of report.nodes) {
        console.log(
          `  Node ${node.url}: Connected=${node.connected}, Height=${node.height}, Genesis=${node.genesisHash}`,
        );
      }
      if (report.passed) {
        console.log('✅ Fulcrum Quorum Verified Successfully');
        process.exit(0);
      } else {
        console.error('❌ Fulcrum Quorum Verification Failed:');
        for (const err of report.failureReasons) {
          console.error(`  - ${err}`);
        }
        process.exit(1);
      }
    }
  })().catch((err) => {
    console.error('Unexpected error during quorum verification:', err);
    process.exit(1);
  });
}
