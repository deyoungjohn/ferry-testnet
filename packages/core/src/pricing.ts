import type { Direction } from './terms.js';
const USD_SCALE = 1000000n;
const BPS = 10000n;
export interface PricingPolicy {
  spreadBps: number;
  fixedFeeUsdMicros: bigint;
}
function units(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new RangeError('Decimals must be an integer from 0 to 36');
  return 10n ** BigInt(decimals);
}
function nonnegative(amount: bigint): void {
  if (amount < 0n) throw new RangeError('Negative amount');
}
function spread(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= 10000)
    throw new RangeError('Invalid spread');
}
function validate(policy: PricingPolicy): void {
  spread(policy.spreadBps);
  nonnegative(policy.fixedFeeUsdMicros);
}
function ceil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
export function convertFloor(amount: bigint, from: number, to: number): bigint {
  nonnegative(amount);
  return (amount * units(to)) / units(from);
}
export function convertCeil(amount: bigint, from: number, to: number): bigint {
  nonnegative(amount);
  return ceil(amount * units(to), units(from));
}
/** Integer-only rational evaluation; floor once at the recipient's base unit. */
export function quoteExactIn(
  amount: bigint,
  from: number,
  to: number,
  policy: PricingPolicy,
): bigint {
  nonnegative(amount);
  validate(policy);
  const fromUnit = units(from),
    toUnit = units(to);
  const numerator =
    (amount * (BPS - BigInt(policy.spreadBps)) * USD_SCALE -
      policy.fixedFeeUsdMicros * BPS * fromUnit) *
    toUnit;
  return numerator <= 0n ? 0n : numerator / (BPS * fromUnit * USD_SCALE);
}
/** Minimal payer base units whose exact-input quote covers amountOut; recipient receives amountOut exactly. */
export function quoteExactOut(
  amountOut: bigint,
  from: number,
  to: number,
  policy: PricingPolicy,
): bigint {
  nonnegative(amountOut);
  validate(policy);
  const fromUnit = units(from),
    toUnit = units(to);
  if (amountOut === 0n) return 0n;
  return ceil(
    (amountOut * USD_SCALE + policy.fixedFeeUsdMicros * toUnit) *
      BPS *
      fromUnit,
    USD_SCALE * toUnit * (BPS - BigInt(policy.spreadBps)),
  );
}
export function checkLimits(
  amount: bigint,
  decimals: number,
  limits: { minUsdMicros: bigint; maxUsdMicros: bigint },
): boolean {
  nonnegative(amount);
  nonnegative(limits.minUsdMicros);
  nonnegative(limits.maxUsdMicros);
  if (limits.minUsdMicros > limits.maxUsdMicros)
    throw new RangeError('Invalid limits');
  const unit = units(decimals),
    scaled = amount * USD_SCALE;
  return (
    scaled >= limits.minUsdMicros * unit && scaled <= limits.maxUsdMicros * unit
  );
}
/** Prices and tolerance are millionths of one USD. Supply every required source; an empty set refuses quoting.
 * Each price must be near $1 and the largest inter-source disagreement must be within tolerance.
 */
export function pegGuard(
  pricesUsdMicros: readonly bigint[],
  toleranceUsdMicros: bigint,
): boolean {
  if (toleranceUsdMicros < 0n || toleranceUsdMicros > USD_SCALE)
    throw new RangeError('Invalid tolerance');
  if (pricesUsdMicros.length === 0) return false;
  let low = pricesUsdMicros[0]!,
    high = low;
  for (const price of pricesUsdMicros) {
    if (
      price <= 0n ||
      price < USD_SCALE - toleranceUsdMicros ||
      price > USD_SCALE + toleranceUsdMicros
    )
      return false;
    if (price < low) low = price;
    if (price > high) high = price;
  }
  return high - low <= toleranceUsdMicros;
}
/** Positive shortageBps means BCH inventory is scarce. Negative values mean counter inventory is scarce. */
export function effectiveSpreadBps(
  base: number,
  shortageBps: number,
  direction: Direction,
  cap: number,
): number {
  spread(base);
  if (!Number.isInteger(shortageBps) || !Number.isInteger(cap) || cap < 0)
    throw new RangeError('Invalid inventory skew');
  const skew =
    Math.max(-cap, Math.min(cap, shortageBps)) *
    (direction === 'COUNTER_TO_BCH' ? 1 : -1);
  return Math.max(0, Math.min(9999, base + skew));
}
