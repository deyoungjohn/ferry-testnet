import WebSocket from 'ws';
import * as libauth from '@bitauth/libauth';
import {
  SignatureTemplate,
  TransactionBuilder,
  MockNetworkProvider,
} from 'cashscript';
import fs from 'node:fs';
import path from 'node:path';

function getEnvPath(): string {
  let dir = process.cwd();
  while (
    !fs.existsSync(path.join(dir, '.env.local')) &&
    path.dirname(dir) !== dir
  ) {
    dir = path.dirname(dir);
  }
  const envPath = path.join(dir, '.env.local');
  if (!fs.existsSync(envPath)) {
    throw new Error('.env.local not found');
  }
  return envPath;
}

interface ServerProbeResult {
  url: string;
  version?: unknown;
  features?: unknown;
  headersSubscribe?: unknown;
  dsproofSubscribeSupport: boolean;
  dsproofSubscribeResponse?: unknown;
  dsproofGetSupport: boolean;
  dsproofGetResponse?: unknown;
  error?: string;
}

async function probeServer(url: string): Promise<ServerProbeResult> {
  console.log(`[Probe] Testing server capabilities for: ${url}`);
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      resolve({
        url,
        dsproofSubscribeSupport: false,
        dsproofGetSupport: false,
        error: 'Timeout after 10000 ms',
      });
    }, 10000);

    const result: ServerProbeResult = {
      url,
      dsproofSubscribeSupport: false,
      dsproofGetSupport: false,
    };

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'server.version',
          params: ['ferry-s05-probe', ['1.4', '1.6']],
        }),
      );
      ws.send(JSON.stringify({ id: 2, method: 'server.features', params: [] }));
      ws.send(
        JSON.stringify({
          id: 3,
          method: 'blockchain.headers.subscribe',
          params: [],
        }),
      );
      // Dummy txid for dsproof methods (64 zeroes)
      const dummyTxid = '00'.repeat(32);
      ws.send(
        JSON.stringify({
          id: 4,
          method: 'blockchain.transaction.dsproof.subscribe',
          params: [dummyTxid],
        }),
      );
      ws.send(
        JSON.stringify({
          id: 5,
          method: 'blockchain.transaction.dsproof.get',
          params: [dummyTxid],
        }),
      );
    });

    const receivedIds = new Set<number>();
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === 1) result.version = msg.result;
        if (msg.id === 2) result.features = msg.result;
        if (msg.id === 3) result.headersSubscribe = msg.result;
        if (msg.id === 4) {
          result.dsproofSubscribeSupport = !msg.error;
          result.dsproofSubscribeResponse = msg.error ? msg.error : msg.result;
        }
        if (msg.id === 5) {
          result.dsproofGetSupport = !msg.error;
          result.dsproofGetResponse = msg.error ? msg.error : msg.result;
        }
        if (msg.id) receivedIds.add(msg.id);
        if (receivedIds.size >= 5) {
          clearTimeout(timeout);
          ws.close();
          resolve(result);
        }
      } catch (e: unknown) {
        console.error('Error parsing response:', e);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        url,
        dsproofSubscribeSupport: false,
        dsproofGetSupport: false,
        error: err.message,
      });
    });
  });
}

class FulcrumLatencyTester {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private pending = new Map<
    number,
    { resolve: (res: unknown) => void; reject: (err: unknown) => void }
  >();
  private notificationListeners = new Map<string, (params: unknown) => void>();

  constructor(private url: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) => reject(err));
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) {
              reject(
                new Error(
                  typeof msg.error === 'string'
                    ? msg.error
                    : msg.error.message || JSON.stringify(msg.error),
                ),
              );
            } else {
              resolve(msg.result);
            }
          }
          if (msg.method && this.notificationListeners.has(msg.method)) {
            this.notificationListeners.get(msg.method)!(msg.params);
          }
        } catch (e) {
          console.error('WS parse error:', e);
        }
      });
    });
  }

  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = ++this.reqId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationListeners.set(method, handler);
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

async function measureChipnetLatency(sampleCount = 10): Promise<{
  samples: Array<{ sample: number; txid: string; latencyMs: number }>;
  minMs: number;
  medianMs: number;
  maxMs: number;
  pass: boolean;
}> {
  console.log(
    `\n[Latency] Starting ${sampleCount}-sample Chipnet self-spend latency benchmark...`,
  );
  const envContent = fs.readFileSync(getEnvPath(), 'utf8');
  const match = envContent.match(/SOLVER_BCH_WIF=([^\r\n]+)/);
  if (!match || !match[1]) {
    throw new Error('SOLVER_BCH_WIF not found in .env.local');
  }

  const wif = match[1].trim();
  const decodedWif = libauth.decodePrivateKeyWif(wif);
  if (typeof decodedWif === 'string') {
    throw new Error(`Invalid WIF: ${decodedWif}`);
  }

  const secp = await libauth.instantiateSecp256k1();
  const pubkey = secp.derivePublicKeyCompressed(decodedWif.privateKey);
  if (typeof pubkey === 'string') {
    throw new Error(`Pubkey derive failed: ${pubkey}`);
  }
  const pkh = libauth.hash160(pubkey);
  const p2pkhBytecode = new Uint8Array([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
  const addrResult = libauth.encodeCashAddress({
    prefix: 'bchtest',
    type: 'p2pkh',
    payload: pkh,
  });
  const address =
    typeof addrResult === 'string' ? addrResult : addrResult.address;

  // Compute electrum scripthash (SHA256 of locking bytecode, reversed)
  const sha = libauth.sha256.hash(p2pkhBytecode);
  const scripthash = libauth.binToHex(new Uint8Array(sha).reverse());

  const client = new FulcrumLatencyTester('wss://chipnet.imaginary.cash:50004');
  await client.connect();

  console.log(
    `[Latency] Connected to Chipnet. Subscribing to scripthash: ${scripthash}`,
  );
  const initialStatus = await client.request<string | null>(
    'blockchain.scripthash.subscribe',
    [scripthash],
  );
  console.log(`[Latency] Initial scripthash status: ${initialStatus}`);

  const samples: Array<{ sample: number; txid: string; latencyMs: number }> =
    [];

  for (let i = 0; i < sampleCount; i++) {
    // 1. Fetch unspent outputs
    const utxos = await client.request<
      Array<{
        height: number;
        tx_hash: string;
        tx_pos: number;
        value: number;
        token_data?: unknown;
      }>
    >('blockchain.scripthash.listunspent', [scripthash, 'include_tokens']);

    // Filter out UTXOs with token_data to avoid touching tPUSD tokens!
    const plainUtxos = utxos.filter((u) => !u.token_data && u.value >= 2000);
    if (plainUtxos.length === 0) {
      throw new Error(
        'No pure BCH UTXO with value >= 2000 sats available for self-spend',
      );
    }

    // Pick highest value UTXO
    plainUtxos.sort((a, b) => b.value - a.value);
    const selectedUtxo = plainUtxos[0]!;

    // Build self-spend:
    // Input: selectedUtxo
    // Output: (value - fee) back to address
    const fee = 300n;
    const sendAmount = BigInt(selectedUtxo.value) - fee;

    const template = new SignatureTemplate(decodedWif.privateKey);
    const provider = new MockNetworkProvider();
    const builder = new TransactionBuilder({ provider });
    builder.addInput(
      {
        txid: selectedUtxo.tx_hash,
        vout: selectedUtxo.tx_pos,
        satoshis: BigInt(selectedUtxo.value),
      },
      template.unlockP2PKH(),
    );
    builder.addOutput({
      to: address,
      amount: sendAmount,
    });

    const txHex = builder.build();

    // Setup notification promise
    let notifyResolve: (latency: number) => void;
    const notifyPromise = new Promise<number>((res) => {
      notifyResolve = res;
    });

    const t0 = performance.now();
    client.onNotification(
      'blockchain.scripthash.subscribe',
      (params: unknown) => {
        const [notifiedScripthash] = (params as [string, unknown]) ?? [];
        if (notifiedScripthash === scripthash) {
          const t1 = performance.now();
          notifyResolve(t1 - t0);
        }
      },
    );

    // Broadcast
    const txid = await client.request<string>(
      'blockchain.transaction.broadcast',
      [txHex],
    );

    // Await notification or timeout after 5000 ms
    const timeoutPromise = new Promise<number>((_, rej) =>
      setTimeout(() => rej(new Error('Notification timeout (5s)')), 5000),
    );
    const latencyMs = await Promise.race([notifyPromise, timeoutPromise]);

    console.log(
      `  [Sample ${i + 1}/${sampleCount}] txid: ${txid} | latency: ${latencyMs.toFixed(1)} ms`,
    );
    samples.push({ sample: i + 1, txid, latencyMs });

    // Brief pause between samples
    await new Promise((r) => setTimeout(r, 600));
  }

  client.close();

  const sortedLatencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const minMs = sortedLatencies[0]!;
  const maxMs = sortedLatencies[sortedLatencies.length - 1]!;
  const mid = Math.floor(sortedLatencies.length / 2);
  const medianMs =
    sortedLatencies.length % 2 !== 0
      ? sortedLatencies[mid]!
      : (sortedLatencies[mid - 1]! + sortedLatencies[mid]!) / 2;

  const pass = medianMs < 2000;
  console.log(`\n[Latency Summary]:`);
  console.log(`  Min:    ${minMs.toFixed(1)} ms`);
  console.log(`  Median: ${medianMs.toFixed(1)} ms (target: < 2000 ms)`);
  console.log(`  Max:    ${maxMs.toFixed(1)} ms`);
  console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);

  return { samples, minMs, medianMs, maxMs, pass };
}

export async function runProbeS05() {
  console.log('=== Ferry S-05 Fulcrum & DSProof Probe ===\n');

  const candidateServers = [
    'wss://chipnet.imaginary.cash:50004',
    'wss://bch.imaginary.cash:50004',
    'wss://fulcrum.greyh.at:50004',
  ];

  const serverResults: ServerProbeResult[] = [];
  for (const url of candidateServers) {
    const res = await probeServer(url);
    serverResults.push(res);
  }

  const latencyResults = await measureChipnetLatency(10);

  return {
    serverResults,
    latencyResults,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProbeS05()
    .then((out) => {
      fs.mkdirSync('/tmp/xo-scratch', { recursive: true });
      fs.writeFileSync(
        '/tmp/xo-scratch/s05-probe-results.json',
        JSON.stringify(out, null, 2),
      );
      console.log(
        '\nProbe complete! Saved output to /tmp/xo-scratch/s05-probe-results.json',
      );
      process.exit(out.latencyResults.pass ? 0 : 1);
    })
    .catch((err) => {
      console.error('Fatal probe error:', err);
      process.exit(1);
    });
}
