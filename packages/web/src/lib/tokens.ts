import { PUSD_SYMBOL } from './config';

export interface TokenMeta {
  readonly symbol: string;
  readonly name: string;
  readonly chain: string;
  readonly chainShort: string;
  readonly glyph: string;
}

export const USDC_BASE: TokenMeta = {
  symbol: 'USDC',
  name: 'USD Coin',
  chain: 'Base',
  chainShort: 'BASE',
  glyph: '$',
};

export const PUSD_BCH: TokenMeta = {
  symbol: PUSD_SYMBOL,
  name: 'PUSD',
  chain: 'Bitcoin Cash',
  chainShort: 'BCH',
  glyph: '₿',
};
