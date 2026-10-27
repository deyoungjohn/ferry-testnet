import { BCH_ELECTRUM_URLS } from '../config';

export interface BchTip {
  readonly height: number;
  readonly source: string;
}

export interface ElectrumTipClient {
  connect(): Promise<void>;
  tipHeight(): Promise<number>;
  close(): void;
}

export type ElectrumTipFactory = (url: string) => ElectrumTipClient;

export interface BchTipReader {
  read(): Promise<number>;
}

export function bchElectrumUrls(): readonly string[] {
  return BCH_ELECTRUM_URLS;
}

export function bchQuoteConfigError(
  network: string,
  urls: readonly string[],
): string | null {
  if (network !== 'mainnet') return null;
  const distinct = new Set(
    urls
      .map((url) => url.trim())
      .filter(Boolean)
      .map((url) => {
        try {
          return new URL(url).hostname.toLowerCase();
        } catch {
          return url.replace(/\/+$/, '').toLowerCase();
        }
      }),
  );
  if (distinct.size < 2) {
    return 'Mainnet quoting requires two independent BCH Electrum endpoints. Set VITE_BCH_ELECTRUM_URL_2.';
  }
  return null;
}

const defaultFactory: ElectrumTipFactory = (url) => {
  let client: ElectrumTipClient | null = null;
  return {
    async connect() {
      const { ElectrumClient } = await import('../../recover/core');
      client = new ElectrumClient(url);
      await client.connect();
    },
    async tipHeight() {
      if (!client) throw new Error('Electrum is not connected');
      return client.tipHeight();
    },
    close() {
      client?.close();
    },
  };
};

export async function fetchBchTip(
  urls: readonly string[] = bchElectrumUrls(),
  factory: ElectrumTipFactory = defaultFactory,
): Promise<BchTip> {
  if (urls.length === 0) {
    throw new Error('No BCH Electrum endpoint is configured');
  }

  const results = await Promise.allSettled(
    urls.map(async (url): Promise<BchTip> => {
      const client = factory(url);
      try {
        await client.connect();
        return { height: await client.tipHeight(), source: url };
      } finally {
        client.close();
      }
    }),
  );

  const tips = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  if (tips.length === 0) {
    const reasons = results
      .flatMap((result) =>
        result.status === 'rejected'
          ? [
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
            ]
          : [],
      )
      .join('; ');
    throw new Error(
      `BCH tip unavailable from every Electrum endpoint${reasons ? `: ${reasons}` : ''}`,
    );
  }

  return tips.reduce((lowest, tip) =>
    tip.height < lowest.height ? tip : lowest,
  );
}

export class ElectrumBchTipReader implements BchTipReader {
  readonly #urls: readonly string[];
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #factory: ElectrumTipFactory;
  #cached: { readonly height: number; readonly at: number } | null = null;
  #pending: Promise<number> | null = null;

  constructor(
    urls: readonly string[] = bchElectrumUrls(),
    ttlMs = 30_000,
    now: () => number = Date.now,
    factory: ElectrumTipFactory = defaultFactory,
  ) {
    this.#urls = urls;
    this.#ttlMs = ttlMs;
    this.#now = now;
    this.#factory = factory;
  }

  async read(): Promise<number> {
    if (this.#cached && this.#now() - this.#cached.at < this.#ttlMs) {
      return this.#cached.height;
    }
    if (this.#pending) return this.#pending;

    this.#pending = fetchBchTip(this.#urls, this.#factory)
      .then((tip) => {
        this.#cached = { height: tip.height, at: this.#now() };
        return tip.height;
      })
      .finally(() => {
        this.#pending = null;
      });
    return this.#pending;
  }
}
