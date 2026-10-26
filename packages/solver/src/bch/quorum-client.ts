import WebSocket from 'ws';
import type {
  ElectrumUtxo,
  ElectrumHistoryEntry,
  BchQuorumStatus,
  DSProofWatcher,
  DSProofEvidence,
} from './types.js';

interface PendingRequest {
  resolve: (res: unknown) => void;
  reject: (err: unknown) => void;
}

export const BCH_GENESIS_HASHES = {
  chipnet: '000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b',
  mainnet: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
} as const;

export class SingleFulcrumClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private tipHeight = 0;
  private tipTimestamp = 0;
  private connected = false;
  private shouldReconnect = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private scriptSubscriptions = new Set<string>();
  private genesisHash: string | null = null;

  public onTipUpdate?: (height: number) => void;
  public onScriptHashNotification?: (
    scriptHash: string,
    status: string,
  ) => void;
  public onConnect?: () => void;
  public onDisconnect?: () => void;

  constructor(public readonly url: string) {}

  getGenesisHash(): string | null {
    return this.genesisHash;
  }

  async fetchFeatures(): Promise<{
    genesis_hash?: string;
    [key: string]: unknown;
  }> {
    const features = await this.request<{
      genesis_hash?: string;
      [key: string]: unknown;
    }>('server.features', []);
    if (features && typeof features.genesis_hash === 'string') {
      this.genesisHash = features.genesis_hash;
    }
    return features;
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    return new Promise((resolve, reject) => {
      let resolved = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.on('open', async () => {
        this.connected = true;
        try {
          // Subscribe to headers
          const header = (await this.request<{ height: number; hex: string }>(
            'blockchain.headers.subscribe',
            [],
          )) as { height: number; hex: string };
          this.tipHeight = header.height;
          this.tipTimestamp = Date.now();
          if (this.onTipUpdate) this.onTipUpdate(header.height);

          // Query server features for genesis check
          try {
            await this.fetchFeatures();
          } catch {
            // Ignored on raw connect; checked strictly in verifyGenesis
          }

          // Resubscribe to scripts if any
          for (const sh of this.scriptSubscriptions) {
            await this.request('blockchain.scripthash.subscribe', [sh]);
          }

          if (this.onConnect) this.onConnect();
          if (!resolved) {
            resolved = true;
            resolve();
          }
        } catch (e) {
          if (!resolved) {
            resolved = true;
            reject(e);
          }
        }
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
            const { resolve: reqResolve, reject: reqReject } =
              this.pendingRequests.get(msg.id)!;
            this.pendingRequests.delete(msg.id);
            if (msg.error) {
              reqReject(
                new Error(
                  typeof msg.error === 'string'
                    ? msg.error
                    : msg.error.message || JSON.stringify(msg.error),
                ),
              );
            } else {
              reqResolve(msg.result);
            }
          }

          // Handle server notifications
          if (
            msg.method === 'blockchain.headers.subscribe' &&
            msg.params?.[0]
          ) {
            this.tipHeight = msg.params[0].height;
            this.tipTimestamp = Date.now();
            if (this.onTipUpdate) this.onTipUpdate(this.tipHeight);
          } else if (
            msg.method === 'blockchain.scripthash.subscribe' &&
            msg.params
          ) {
            const [sh, status] = msg.params;
            if (this.onScriptHashNotification) {
              this.onScriptHashNotification(sh, status);
            }
          }
        } catch {
          // Ignore parse errors from malformed frames
        }
      });

      ws.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      ws.on('close', () => {
        this.connected = false;
        if (this.onDisconnect) this.onDisconnect();
        this.failPendingRequests(new Error('Connection closed'));
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;
      try {
        await this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, 2000);
  }

  private failPendingRequests(err: Error): void {
    for (const [id, req] of this.pendingRequests.entries()) {
      req.reject(err);
      this.pendingRequests.delete(id);
    }
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  getTip(): { height: number; timestamp: number } {
    return { height: this.tipHeight, timestamp: this.tipTimestamp };
  }

  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    if (!this.isConnected()) {
      throw new Error(`FulcrumClient (${this.url}) is not connected`);
    }
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (res: unknown) => void,
        reject,
      });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  async subscribeScriptHash(scriptHash: string): Promise<string | null> {
    this.scriptSubscriptions.add(scriptHash);
    if (this.isConnected()) {
      return this.request<string | null>('blockchain.scripthash.subscribe', [
        scriptHash,
      ]);
    }
    return null;
  }

  async unsubscribeScriptHash(scriptHash: string): Promise<void> {
    this.scriptSubscriptions.delete(scriptHash);
    if (this.isConnected()) {
      try {
        await this.request('blockchain.scripthash.unsubscribe', [scriptHash]);
      } catch {
        // Some servers don't implement unsubscribe; ignore
      }
    }
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

export class BchQuorumClient implements DSProofWatcher {
  private clients: SingleFulcrumClient[] = [];
  private scriptCallbacks = new Map<
    string,
    Set<(status: string | null) => void>
  >();
  private knownHistory = new Map<string, Set<string>>();

  constructor(
    serverUrls: string[],
    public readonly expectedNetwork?: 'chipnet' | 'mainnet' | 'testnet',
  ) {
    if (serverUrls.length === 0) {
      throw new Error('At least one Fulcrum server URL must be configured');
    }
    this.clients = serverUrls.map((url) => new SingleFulcrumClient(url));

    for (const client of this.clients) {
      client.onScriptHashNotification = (sh, status) => {
        const callbacks = this.scriptCallbacks.get(sh);
        if (callbacks) {
          for (const cb of callbacks) cb(status);
        }
      };

      client.onConnect = async () => {
        // History reconciliation after reconnect (CH-02 / CH-04)
        for (const sh of this.scriptCallbacks.keys()) {
          await this.reconcileScriptHash(sh);
        }
      };
    }
  }

  async connect(): Promise<void> {
    const connectPromises = this.clients.map((c) =>
      c.connect().catch(() => {
        // Return null if a node is temporarily down
        return null;
      }),
    );
    await Promise.all(connectPromises);

    if (this.expectedNetwork) {
      await this.verifyGenesis(this.expectedNetwork);
    }
  }

  async verifyGenesis(
    network?: 'chipnet' | 'mainnet' | 'testnet',
  ): Promise<void> {
    const rawNetwork = network || this.expectedNetwork || 'chipnet';
    const targetNetwork = rawNetwork === 'mainnet' ? 'mainnet' : 'chipnet';
    const expectedHash = BCH_GENESIS_HASHES[targetNetwork];

    for (const client of this.clients) {
      if (!client.isConnected()) {
        await client.connect();
      }
      let hash = client.getGenesisHash();
      if (!hash) {
        const features = await client.fetchFeatures();
        hash = features.genesis_hash || null;
      }
      if (!hash) {
        throw new Error(
          `Fulcrum server (${client.url}) failed genesis verification: server.features missing genesis_hash`,
        );
      }
      if (hash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new Error(
          `Fulcrum server (${client.url}) returned genesis hash ${hash}, expected ${expectedHash} for network ${targetNetwork}`,
        );
      }
    }
  }

  async reconcileScriptHash(scriptHash: string): Promise<void> {
    try {
      const history = await this.getHistory(scriptHash);
      let seen = this.knownHistory.get(scriptHash);
      if (!seen) {
        seen = new Set<string>();
        this.knownHistory.set(scriptHash, seen);
      }
      for (const entry of history) {
        if (!seen.has(entry.tx_hash)) {
          seen.add(entry.tx_hash);
          const callbacks = this.scriptCallbacks.get(scriptHash);
          if (callbacks) {
            for (const cb of callbacks) cb('reconciled');
          }
        }
      }
    } catch {
      // Reconcile failed; will retry on next poll or reconnect
    }
  }

  getQuorumStatus(): BchQuorumStatus {
    const tips: { [url: string]: number } = {};
    let minTip = Infinity;
    let maxTip = 0;
    let newestTimestamp = 0;
    let connectedCount = 0;

    for (const client of this.clients) {
      if (client.isConnected()) {
        const { height, timestamp } = client.getTip();
        if (height > 0) {
          tips[client.url] = height;
          if (height < minTip) minTip = height;
          if (height > maxTip) maxTip = height;
          if (timestamp > newestTimestamp) newestTimestamp = timestamp;
          connectedCount++;
        }
      }
    }

    if (connectedCount === 0) {
      return {
        quorumTip: 0,
        tips,
        isQuorumHealthy: false,
        ageSeconds: Infinity,
      };
    }

    // Quorum check: if at least 2 connected, abs(max - min) <= 1
    const isQuorumHealthy =
      connectedCount >= Math.min(2, this.clients.length) &&
      (connectedCount === 1 || maxTip - minTip <= 1);

    const ageSeconds =
      newestTimestamp > 0
        ? Math.floor((Date.now() - newestTimestamp) / 1000)
        : Infinity;

    return {
      quorumTip: minTip === Infinity ? 0 : minTip,
      tips,
      isQuorumHealthy,
      ageSeconds,
    };
  }

  private getActiveClient(): SingleFulcrumClient {
    const client = this.clients.find((c) => c.isConnected());
    if (!client) {
      throw new Error('No BCH Fulcrum clients currently connected');
    }
    return client;
  }

  async listUnspent(
    scriptHash: string,
    tokenFilter:
      'include_tokens' | 'tokens_only' | 'exclude_tokens' = 'include_tokens',
  ): Promise<ElectrumUtxo[]> {
    return this.executeWithFailover((client) =>
      client.request<ElectrumUtxo[]>('blockchain.scripthash.listunspent', [
        scriptHash,
        tokenFilter,
      ]),
    );
  }

  async getHistory(scriptHash: string): Promise<ElectrumHistoryEntry[]> {
    return this.executeWithFailover((client) =>
      client.request<ElectrumHistoryEntry[]>(
        'blockchain.scripthash.get_history',
        [scriptHash],
      ),
    );
  }

  async broadcast(txHex: string): Promise<string> {
    return this.executeWithFailover((client) =>
      client.request<string>('blockchain.transaction.broadcast', [txHex]),
    );
  }

  async getTransaction(txid: string, verbose = true): Promise<unknown> {
    return this.executeWithFailover((client) =>
      client.request('blockchain.transaction.get', [txid, verbose]),
    );
  }

  async getDSProof(txid: string): Promise<unknown | null> {
    try {
      return await this.executeWithFailover((client) =>
        client.request('blockchain.transaction.dsproof.get', [txid]),
      );
    } catch {
      return null;
    }
  }

  async subscribeScriptHash(
    scriptHash: string,
    callback: (status: string | null) => void,
  ): Promise<void> {
    let callbacks = this.scriptCallbacks.get(scriptHash);
    if (!callbacks) {
      callbacks = new Set();
      this.scriptCallbacks.set(scriptHash, callbacks);
      for (const client of this.clients) {
        await client.subscribeScriptHash(scriptHash);
      }
    }
    callbacks.add(callback);
  }

  unsubscribeScriptHash(
    scriptHash: string,
    callback: (status: string | null) => void,
  ): void {
    const callbacks = this.scriptCallbacks.get(scriptHash);
    if (callbacks) {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.scriptCallbacks.delete(scriptHash);
        for (const client of this.clients) {
          client.unsubscribeScriptHash(scriptHash);
        }
      }
    }
  }

  private async executeWithFailover<T>(
    operation: (client: SingleFulcrumClient) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (const client of this.clients) {
      if (client.isConnected()) {
        try {
          return await operation(client);
        } catch (err) {
          lastError = err;
        }
      }
    }
    throw (
      lastError || new Error('All Fulcrum clients failed to execute request')
    );
  }

  // DSProofWatcher implementation (defaults to safe lane)
  subscribe(txid: string, callback: (evidence: DSProofEvidence) => void): void {
    // S-05 default: no fast-lane dsproof found, safe lane default
    callback({ txid, hasProof: false });
  }

  unsubscribe(): void {}

  close(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.scriptCallbacks.clear();
  }
}
