import { WebSocket } from 'ws';

export interface ElectrumUtxo {
  height: number;
  tx_hash: string;
  tx_pos: number;
  value: number;
  token_data?: {
    category: string;
    amount: string;
    nft?: {
      capability: string;
      commitment: string;
    };
  };
}

export class FulcrumClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (res: unknown) => void; reject: (err: unknown) => void }
  >();
  private tipHeight = 0;

  constructor(private url: string = 'wss://chipnet.imaginary.cash:50004') {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        resolve();
      });

      this.ws.on('error', (err) => {
        reject(err);
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
            const { resolve, reject } = this.pendingRequests.get(msg.id)!;
            this.pendingRequests.delete(msg.id);
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
          if (
            msg.method === 'blockchain.headers.subscribe' &&
            msg.params &&
            msg.params[0]
          ) {
            this.tipHeight = msg.params[0].height;
          }
        } catch (e) {
          console.error('Failed to parse Fulcrum message:', e);
        }
      });
    });
  }

  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('FulcrumClient is not connected');
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

  async listUnspent(
    scriptHash: string,
    tokenFilter:
      'include_tokens' | 'tokens_only' | 'exclude_tokens' = 'include_tokens',
  ): Promise<ElectrumUtxo[]> {
    return this.request<ElectrumUtxo[]>('blockchain.scripthash.listunspent', [
      scriptHash,
      tokenFilter,
    ]);
  }

  async broadcast(txHex: string): Promise<string> {
    return this.request<string>('blockchain.transaction.broadcast', [txHex]);
  }

  async getTipHeight(): Promise<number> {
    const header = await this.request<{ height: number; hex: string }>(
      'blockchain.headers.subscribe',
      [],
    );
    this.tipHeight = header.height;
    return header.height;
  }

  async getTransaction(txid: string, verbose = false): Promise<unknown> {
    return this.request('blockchain.transaction.get', [txid, verbose]);
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
