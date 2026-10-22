/**
 * Chromium can use an SVG filter as a backdrop-filter (`.glass--lensed`).
 * Safari and Firefox parse the property but do not lens the backdrop, so a
 * bare CSS.supports() check is not enough. This module keeps the testable
 * decision separate from the browser globals.
 */

export interface LensEnvironment {
  supports: (property: string, value: string) => boolean;
  userAgent: string;
  brands?: readonly { readonly brand: string }[];
}

export function isLensSupported(env: LensEnvironment): boolean {
  const supportsFilter =
    env.supports('backdrop-filter', 'url("#ferry-lens") blur(1px)') ||
    env.supports('-webkit-backdrop-filter', 'url("#ferry-lens") blur(1px)');

  if (!supportsFilter) return false;

  if (env.brands && env.brands.length > 0) {
    return env.brands.some((entry) => /chromium/i.test(entry.brand));
  }

  return /Chromium\//.test(env.userAgent);
}

type NavigatorWithBrands = Navigator & {
  userAgentData?: { brands?: readonly { brand: string }[] };
};

export function detectLensSupport(): boolean {
  if (typeof window === 'undefined' || typeof window.CSS?.supports !== 'function') {
    return false;
  }

  const nav = window.navigator as NavigatorWithBrands;

  return isLensSupported({
    supports: (property, value) => window.CSS.supports(property, value),
    userAgent: nav.userAgent,
    brands: nav.userAgentData?.brands,
  });
}
