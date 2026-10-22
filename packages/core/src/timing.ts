export interface TimingConfig {
  solverReactionSeconds: number;
  safetySeconds: number;
  blockMeanSeconds: number;
  minReverseRemainingBlocks: number;
}
/** Reaction time is an explicit lab assumption (60 s), not a measured service guarantee. */
export const DEFAULT_TIMING_CONFIG: Readonly<TimingConfig> = Object.freeze({
  solverReactionSeconds: 60,
  safetySeconds: 7200,
  blockMeanSeconds: 600,
  minReverseRemainingBlocks: 108,
});
export interface CounterLockTime {
  unixSeconds: number;
  bchTipHeight: number;
}
export interface DeadlineTerms {
  counterDeadline: number;
  bchRefundHeight: number;
}
export interface TimingDecision {
  allowed: boolean;
  remainingBlocks: number;
  availableSeconds: number;
  requiredSeconds: number;
  marginSeconds: number;
  reason: 'ok' | 'expired' | 'remaining-blocks' | 'insufficient-margin';
}
/** Invert the integer-shape Gamma CDF by bracketing and bisection.
 * Q(n,x)=exp(-x) sum(k=0..n-1,x^k/k!), DLMF 8.4.8.
 * Log-sum-exp prevents overflow; expm1 preserves the small lower-tail probability.
 * https://dlmf.nist.gov/8.4.E8 . Shape is bounded to 10,000 to bound CPU use.
 */
export function erlangQuantile(
  blocks: number,
  probability: number,
  meanSeconds = 600,
): number {
  if (
    !Number.isInteger(blocks) ||
    blocks < 0 ||
    blocks > 10000 ||
    !(probability > 0 && probability < 1) ||
    !Number.isFinite(meanSeconds) ||
    meanSeconds <= 0
  )
    throw new RangeError('Invalid Erlang parameters');
  if (blocks === 0) return 0;
  function cdf(x: number): number {
    if (x === 0) return 0;
    let term = 0,
      sum = 0;
    for (let k = 1; k < blocks; k++) {
      term += Math.log(x) - Math.log(k);
      const largest = Math.max(sum, term);
      sum = largest + Math.log1p(Math.exp(Math.min(sum, term) - largest));
    }
    return -Math.expm1(Math.min(0, sum - x));
  }
  let low = 0,
    high = blocks;
  while (cdf(high) < probability) high *= 2;
  for (let i = 0; i < 100; i++) {
    const middle = (low + high) / 2;
    if (cdf(middle) < probability) low = middle;
    else high = middle;
  }
  return ((low + high) / 2) * meanSeconds;
}
function validate(
  terms: DeadlineTerms,
  start: CounterLockTime,
  config: TimingConfig,
): number {
  for (const value of [
    terms.counterDeadline,
    start.unixSeconds,
    config.safetySeconds,
    config.solverReactionSeconds,
  ])
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError('Invalid time');
  for (const value of [
    terms.bchRefundHeight,
    start.bchTipHeight,
    config.minReverseRemainingBlocks,
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError('Invalid height');
  if (!Number.isFinite(config.blockMeanSeconds) || config.blockMeanSeconds <= 0)
    throw new RangeError('Invalid block mean');
  return terms.bchRefundHeight - start.bchTipHeight;
}
function result(
  remainingBlocks: number,
  availableSeconds: number,
  requiredSeconds: number,
  expired: boolean,
  minBlocks: number,
): TimingDecision {
  const marginSeconds = availableSeconds - requiredSeconds;
  const reason = expired
    ? 'expired'
    : remainingBlocks < minBlocks
      ? 'remaining-blocks'
      : marginSeconds < 0
        ? 'insufficient-margin'
        : 'ok';
  return {
    allowed: reason === 'ok',
    remainingBlocks,
    availableSeconds,
    requiredSeconds,
    marginSeconds,
    reason,
  };
}
export function invariantF(
  terms: DeadlineTerms,
  start: CounterLockTime,
  config: TimingConfig = DEFAULT_TIMING_CONFIG,
): TimingDecision {
  const n = validate(terms, start, config),
    available = terms.counterDeadline - start.unixSeconds;
  const required =
    erlangQuantile(Math.max(0, n), 0.9999, config.blockMeanSeconds) +
    config.solverReactionSeconds +
    config.safetySeconds;
  return result(n, available, required, available <= 0 || n <= 0, 1);
}
export function invariantR(
  terms: DeadlineTerms,
  start: CounterLockTime,
  config: TimingConfig = DEFAULT_TIMING_CONFIG,
): TimingDecision {
  const n = validate(terms, start, config),
    duration = terms.counterDeadline - start.unixSeconds;
  const available = erlangQuantile(
    Math.max(0, n),
    0.0001,
    config.blockMeanSeconds,
  );
  return result(
    n,
    available,
    Math.max(0, duration) + config.solverReactionSeconds + config.safetySeconds,
    duration <= 0 || n <= 0,
    config.minReverseRemainingBlocks,
  );
}
