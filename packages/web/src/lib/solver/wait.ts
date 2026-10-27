import { FAST_LANE_MAX_USD_MICROS, PUSD_DECIMALS } from '../config';

export const WAIT_STALL_SECONDS = 180;
export const BCH_CONFIRMATIONS_REQUIRED = 1;

export function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const remaining = safe % 60;
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60).toString()}h ${(minutes % 60).toString()}m`;
  }
  return minutes > 0
    ? `${minutes.toString()}m ${remaining.toString()}s`
    : `${remaining.toString()}s`;
}

export function fastLaneMaxTokenAmount(): bigint {
  return FAST_LANE_MAX_USD_MICROS / 10n ** BigInt(6 - PUSD_DECIMALS);
}

export function isFastLaneEligible(tokenAmount: bigint): boolean {
  return tokenAmount <= fastLaneMaxTokenAmount();
}
