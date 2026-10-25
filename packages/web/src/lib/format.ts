import { formatUnits } from 'viem';

function groupWhole(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatBaseUnits(
  value: bigint,
  decimals: number,
  maxFractionDigits = decimals,
): string {
  const shownDigits = Math.max(0, Math.min(decimals, maxFractionDigits));
  const discardedDigits = decimals - shownDigits;
  const factor = 10n ** BigInt(discardedDigits);
  const rounded =
    discardedDigits === 0 ? value : ((value + factor / 2n) / factor) * factor;
  const [whole = '0', fraction = ''] = formatUnits(rounded, decimals).split(
    '.',
  );
  const trimmed = fraction.slice(0, shownDigits).replace(/0+$/, '');
  return `${groupWhole(whole)}${trimmed ? `.${trimmed}` : ''}`;
}

export function formatUsdMicros(value: bigint, maxFractionDigits = 2): string {
  return `$${formatBaseUnits(value, 6, maxFractionDigits)}`;
}

export function formatBasisPoints(basisPoints: number): string {
  const sign = basisPoints < 0 ? '-' : '';
  const absolute = Math.abs(basisPoints);
  const whole = Math.floor(absolute / 100);
  const fraction = (absolute % 100)
    .toString()
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ''}%`;
}

export function formatUtcTimestamp(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1_000);
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date);
}
