import type { PegPoint } from './types';

const TARGET_USD_MICROS = 1_000_000n;

export function sparklineCoordinates(
  points: readonly PegPoint[],
  width = 240,
  height = 72,
): { readonly line: string; readonly targetY: number } | null {
  if (points.length < 2) return null;
  const ordered = [...points].sort((left, right) => left.at - right.at);
  const minAt = ordered[0]?.at ?? 0;
  const maxAt = ordered.at(-1)?.at ?? minAt + 1;
  const prices = ordered.map((point) => point.priceUsdMicros);
  let minPrice = prices.reduce(
    (lowest, price) => (price < lowest ? price : lowest),
    TARGET_USD_MICROS,
  );
  let maxPrice = prices.reduce(
    (highest, price) => (price > highest ? price : highest),
    TARGET_USD_MICROS,
  );
  if (minPrice === maxPrice) {
    minPrice -= 5_000n;
    maxPrice += 5_000n;
  }

  const pad = 4;
  const xSpan = Math.max(1, maxAt - minAt);
  const ySpan = Number(maxPrice - minPrice);
  const x = (at: number) => pad + ((at - minAt) / xSpan) * (width - pad * 2);
  const y = (price: bigint) =>
    pad + (1 - Number(price - minPrice) / ySpan) * (height - pad * 2);

  return {
    line: ordered
      .map(
        (point) =>
          `${x(point.at).toFixed(2)},${y(point.priceUsdMicros).toFixed(2)}`,
      )
      .join(' '),
    targetY: y(TARGET_USD_MICROS),
  };
}
