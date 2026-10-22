import WebSocket from 'ws';

export interface CashTokenBalance {
  category: string;
  amount: bigint;
  nftCount: number;
}

export interface BchBalanceResult {
  address: string;
  confirmedSats: number;
  unconfirmedSats: number;
  totalSats: number;
  totalBch: string;
  tokens: CashTokenBalance[];
}

export class ElectrumClient {
  private url: string;
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

  constructor(url: string = 'wss://chipnet.imaginary.cash:50004') {
    this.url = url;
  }

  async connect(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection to ${this.url} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.on('open', async () => {
        clearTimeout(timer);
        this.ws = ws;
        try {
          await this.call('server.version', ['FerryBalancesClient', '1.4']);
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) {
              reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              resolve(msg.result);
            }
          }
        } catch (e) {
          // ignore malformed frame
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      ws.on('close', () => {
        this.ws = null;
        for (const [_, p] of this.pending) {
          p.reject(new Error('WebSocket closed'));
        }
        this.pending.clear();
      });
    });
  }

  async call(method: string, params: any[]): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Electrum client is not connected');
    }
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC call ${method} timed out`));
      }, 10000);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timeout);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  async getBalanceAndTokens(cashAddress: string): Promise<BchBalanceResult> {
    const balanceRes = await this.call('blockchain.address.get_balance', [cashAddress]);
    const confirmedSats = Number(balanceRes.confirmed ?? 0);
    const unconfirmedSats = Number(balanceRes.unconfirmed ?? 0);
    const totalSats = confirmedSats + unconfirmedSats;
    const totalBch = (totalSats / 1e8).toFixed(8);

    // Query UTXOs for tokens
    const utxos: any[] = await this.call('blockchain.address.listunspent', [cashAddress]);
    const tokenMap = new Map<string, { amount: bigint; nftCount: number }>();

    for (const utxo of utxos) {
      if (utxo.token_data) {
        const cat = utxo.token_data.category;
        const amt = BigInt(utxo.token_data.amount || 0);
        const hasNft = !!utxo.token_data.nft;
        const existing = tokenMap.get(cat) || { amount: 0n, nftCount: 0 };
        existing.amount += amt;
        if (hasNft) existing.nftCount += 1;
        tokenMap.set(cat, existing);
      }
    }

    const tokens: CashTokenBalance[] = Array.from(tokenMap.entries()).map(([category, data]) => ({
      category,
      amount: data.amount,
      nftCount: data.nftCount
    }));

    return {
      address: cashAddress,
      confirmedSats,
      unconfirmedSats,
      totalSats,
      totalBch,
      tokens
    };
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
