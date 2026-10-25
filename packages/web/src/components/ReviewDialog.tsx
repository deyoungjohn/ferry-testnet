import { FIXED_FEE_USD_MICROS, PUSD_SYMBOL, SPREAD_BPS } from '../lib/config';
import { formatBasisPoints, formatUsdMicros } from '../lib/format';
import type { RecoveryFile } from '../lib/recovery';
import type { SignedQuote } from '../lib/solver/types';
import { formatDuration } from '../lib/solver/view';
import {
  formatPusd,
  formatUsdc,
  quoteRate,
  truncateAddress,
} from '../lib/swap';
import { GlassModal } from './GlassModal';
import { CheckIcon } from './icons';

export interface ReviewDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly quote: SignedQuote;
  readonly recovery: RecoveryFile | null;
  readonly recoveryDownloaded: boolean;
  readonly expired: boolean;
  readonly busy: boolean;
  readonly reverse: boolean;
  readonly now: number;
  readonly onDownload: () => void;
  readonly onConfirm: () => void;
}

export function ReviewDialog({
  open,
  onOpenChange,
  quote,
  recovery,
  recoveryDownloaded,
  expired,
  busy,
  reverse,
  now,
  onDownload,
  onConfirm,
}: ReviewDialogProps) {
  const send = reverse
    ? `${formatPusd(quote.terms.bchTokenAmount)} ${PUSD_SYMBOL}`
    : `${formatUsdc(quote.terms.counterAmount)} USDC`;
  const receive = reverse
    ? `${formatUsdc(quote.terms.counterAmount)} USDC`
    : `${formatPusd(quote.terms.bchTokenAmount)} ${PUSD_SYMBOL}`;

  return (
    <GlassModal
      open={open}
      onOpenChange={onOpenChange}
      title="Review and confirm"
      description="The solver signature covers every term below. The recovery file is the only way to recover this swap without this browser."
      footer={
        <div className="space-y-2">
          {recovery && !recoveryDownloaded ? (
            <button
              type="button"
              onClick={onDownload}
              className="flex h-11 w-full items-center justify-center rounded-pill border border-hairline bg-surface-2 text-sm font-medium text-text transition-colors hover:border-lime/30 hover:text-lime"
            >
              Download recovery file
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy || expired || !recoveryDownloaded || !recovery}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
            className="flex h-12 w-full items-center justify-center gap-1.5 rounded-pill bg-olive px-5 text-sm font-semibold text-text shadow-pill transition-[filter,transform] hover:brightness-110 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy
              ? 'Signing and relaying…'
              : expired
                ? 'Quote expired — get a fresh quote'
                : recoveryDownloaded
                  ? 'Confirm and ferry'
                  : 'Download the recovery file first'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-well border border-hairline bg-surface-2/60 p-3.5">
          <div>
            <p className="text-[10px] tracking-[0.14em] text-text-muted uppercase">
              You send
            </p>
            <p className="mt-1 text-sm font-medium tabular-nums text-text">
              {send}
            </p>
          </div>
          <span aria-hidden="true" className="text-text-muted">
            →
          </span>
          <div className="text-right">
            <p className="text-[10px] tracking-[0.14em] text-text-muted uppercase">
              You receive
            </p>
            <p className="mt-1 text-sm font-medium tabular-nums text-lime">
              {receive}
            </p>
          </div>
        </div>

        <dl className="divide-y divide-hairline border-y border-hairline text-xs">
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-text-muted">Rate</dt>
            <dd className="font-medium tabular-nums text-text">
              {reverse
                ? `1 ${PUSD_SYMBOL} = ${quoteRate(quote.terms)} USDC`
                : `1 USDC = ${quoteRate(quote.terms)} ${PUSD_SYMBOL}`}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-text-muted">Spread / fixed fee</dt>
            <dd className="font-medium tabular-nums text-text">
              {formatBasisPoints(SPREAD_BPS)} /{' '}
              {formatUsdMicros(FIXED_FEE_USD_MICROS)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-text-muted">Quote expires</dt>
            <dd className="font-medium tabular-nums text-text">
              {formatDuration(Math.max(0, quote.terms.quoteExpiry - now))}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-text-muted">Solver</dt>
            <dd className="font-mono text-[10px] text-text">
              {truncateAddress(quote.terms.solverCounterAddress, 10, 6)}
            </dd>
          </div>
        </dl>

        <p
          className={[
            'flex items-start gap-2 text-[11px] leading-5',
            recoveryDownloaded ? 'text-ok' : 'text-text-muted',
          ].join(' ')}
        >
          {recoveryDownloaded ? (
            <CheckIcon className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <span
              aria-hidden="true"
              className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn"
            />
          )}
          {recoveryDownloaded
            ? 'Recovery file downloaded. Keep it somewhere safe.'
            : 'Download the recovery file before confirming. It is not stored anywhere else.'}
        </p>
      </div>
    </GlassModal>
  );
}
