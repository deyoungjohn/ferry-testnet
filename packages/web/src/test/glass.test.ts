import { describe, expect, it } from 'vitest';
import { isLensSupported, type LensEnvironment } from '../lib/glass';

const baseEnv: LensEnvironment = {
  supports: () => true,
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
  brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }],
};

describe('isLensSupported', () => {
  it('accepts Chromium when the SVG filter form is parsed', () => {
    expect(isLensSupported(baseEnv)).toBe(true);
  });

  it('rejects engines that parse the filter but do not lens the backdrop', () => {
    expect(
      isLensSupported({
        supports: () => true,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
        brands: [],
      }),
    ).toBe(false);
  });

  it('rejects browsers that do not support the property at all', () => {
    expect(
      isLensSupported({
        supports: () => false,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0',
        brands: [],
      }),
    ).toBe(false);
  });

  it('falls back to the user agent when userAgentData is unavailable', () => {
    expect(
      isLensSupported({
        supports: () => true,
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chromium/140.0',
      }),
    ).toBe(true);

    expect(
      isLensSupported({
        supports: () => true,
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
      }),
    ).toBe(false);
  });
});
