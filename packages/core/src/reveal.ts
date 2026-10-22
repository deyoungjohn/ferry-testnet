import type { CounterChain } from './terms.js';
export type Lane = 'fast' | 'safe';
export interface LockEvidence {
  exists: boolean;
  confirmations: number;
  safe?: boolean;
  finalized?: boolean;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  ageSeconds?: number;
  dsproof?: 'clear' | 'detected' | 'unavailable';
  dsproofElapsedMs?: number;
}
export interface RevealInput {
  chain: 'bch' | CounterChain;
  lane: Lane;
  fastOptIn: boolean;
  amountUsdMicros: bigint;
  evidence: LockEvidence;
}
export interface RevealConfig {
  zeroConfMaxUsdMicros: bigint;
  dsproofWindowMs: number;
  baseConfirmations: number;
  ethereumConfirmations: number;
  arbitrumAgeSeconds: number;
  tronConfirmations: number;
}
export const DEFAULT_REVEAL_CONFIG: Readonly<RevealConfig> = Object.freeze({
  zeroConfMaxUsdMicros: 25000000n,
  dsproofWindowMs: 5000,
  baseConfirmations: 10,
  ethereumConfirmations: 3,
  arbitrumAgeSeconds: 10,
  tronConfirmations: 19,
});
export interface RevealDecision {
  allowed: boolean;
  reason:
    | 'ready'
    | 'missing-lock'
    | 'fast-consent'
    | 'fast-cap'
    | 'dsproof'
    | 'waiting-finality';
}
/** Evidence must refer to the verified terms' live canonical lock. F/R timing is
 * an additional mandatory gate. An unavailable DSProof feed is not a clear feed.
 * Arc/BSC require explicit finality; provisional route policies are reverified at L6.
 */
export function revealPolicy(
  input: RevealInput,
  config: RevealConfig = DEFAULT_REVEAL_CONFIG,
): RevealDecision {
  const e = input.evidence;
  if (input.amountUsdMicros < 0n || config.zeroConfMaxUsdMicros < 0n)
    throw new RangeError('Invalid reveal amount');
  for (const value of [
    e.confirmations,
    config.dsproofWindowMs,
    config.baseConfirmations,
    config.ethereumConfirmations,
    config.arbitrumAgeSeconds,
    config.tronConfirmations,
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError('Invalid confirmation policy');
  for (const value of [e.ageSeconds, e.dsproofElapsedMs])
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new RangeError('Invalid observation age');
  for (const threshold of [
    config.dsproofWindowMs,
    config.baseConfirmations,
    config.ethereumConfirmations,
    config.arbitrumAgeSeconds,
    config.tronConfirmations,
  ]) {
    if (threshold === 0)
      throw new RangeError('Finality thresholds must be positive');
  }
  if (!e.exists) return { allowed: false, reason: 'missing-lock' };
  if (input.lane === 'fast' && !input.fastOptIn)
    return { allowed: false, reason: 'fast-consent' };
  if (
    input.lane === 'fast' &&
    input.amountUsdMicros > config.zeroConfMaxUsdMicros
  )
    return { allowed: false, reason: 'fast-cap' };
  if (input.chain === 'bch' && e.dsproof === 'detected')
    return { allowed: false, reason: 'dsproof' };
  let ready = false;
  switch (input.chain) {
    case 'bch':
      ready =
        e.confirmations >= 1 ||
        (input.lane === 'fast' &&
          e.dsproof === 'clear' &&
          (e.dsproofElapsedMs ?? -1) >= config.dsproofWindowMs);
      break;
    case 'base':
      ready =
        e.confirmations >= config.baseConfirmations &&
        (input.lane === 'fast' || e.safe === true || e.finalized === true);
      break;
    case 'ethereum':
      ready =
        e.confirmations >= config.ethereumConfirmations &&
        (input.lane === 'fast' || e.finalized === true);
      break;
    case 'arbitrum':
      ready =
        e.confirmations >= 1 &&
        (e.ageSeconds ?? -1) >= config.arbitrumAgeSeconds &&
        (input.lane === 'fast' || e.safe === true || e.finalized === true);
      break;
    case 'solana':
      ready =
        e.commitment === 'finalized' ||
        (input.lane === 'fast' && e.commitment === 'confirmed');
      break;
    case 'arc':
    case 'bsc':
      ready = e.confirmations >= 1 && e.finalized === true;
      break;
    case 'tron':
      ready =
        e.confirmations >= config.tronConfirmations && e.finalized === true;
      break;
  }
  return { allowed: ready, reason: ready ? 'ready' : 'waiting-finality' };
}
