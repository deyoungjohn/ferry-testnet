import type pino from 'pino';

export interface PriceSource {
  getPrices(asset: string): Promise<bigint[]>;
}

/**
 * Explicit, logged testnet stub implementation returning 1.00 USD across simulated sources.
 */
export class TestnetStubPriceSource implements PriceSource {
  constructor(private readonly logger?: pino.Logger) {}

  async getPrices(asset: string): Promise<bigint[]> {
    if (this.logger) {
      this.logger.info(
        { asset, priceUsd: 1.0 },
        'Testnet stub price source queried; returning pegged price 1.00 USD',
      );
    }
    // Returns 1.00 USD (1,000,000 micros) across 2 simulated oracle / exchange feeds
    return [1000000n, 1000000n];
  }
}
