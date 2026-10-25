import type { OrderViewModel } from '../lib/solver/view';
import { explorerTxUrl } from '../lib/config';
import { truncateAddress } from '../lib/swap';
import { CheckIcon } from './icons';
import { GlassSheet } from './GlassSheet';

export interface StatusDrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly view: OrderViewModel;
  readonly orderId: string;
}

export function StatusDrawer({
  open,
  onOpenChange,
  view,
  orderId,
}: StatusDrawerProps) {
  return (
    <GlassSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Live swap timeline"
      description={`${view.statusLabel} · ${truncateAddress(orderId, 10, 8)}`}
    >
      <div className="grid grid-cols-2 gap-3 border-b border-hairline pb-4 text-[11px]">
        <div>
          <p className="text-text-muted">Base deadline</p>
          <p className="mt-0.5 font-medium tabular-nums text-text">
            {formatCountdown(view.counterTimeRemainingSeconds)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-text-muted">BCH refund</p>
          <p className="mt-0.5 font-medium tabular-nums text-text">
            {view.blocksRemaining} blocks ·{' '}
            {formatCountdown(view.bchTimeRemainingSeconds)}
          </p>
        </div>
      </div>
      <ol className="mt-4 space-y-0">
        {view.steps.map((step, index) => (
          <li key={step.key} className="relative flex gap-3 pb-5 last:pb-0">
            {index < view.steps.length - 1 ? (
              <span
                aria-hidden="true"
                className={[
                  'absolute top-5 left-[9px] h-full w-px',
                  step.state === 'done' ? 'bg-ok/40' : 'bg-hairline',
                ].join(' ')}
              />
            ) : null}
            <span
              className={[
                'relative z-10 mt-0.5 grid size-[19px] shrink-0 place-items-center rounded-full border text-[9px]',
                step.state === 'done'
                  ? 'border-ok/40 bg-ok/15 text-ok'
                  : step.state === 'current'
                    ? 'border-lime/50 bg-lime/15 text-lime'
                    : step.state === 'error'
                      ? 'border-danger/40 bg-danger/10 text-danger'
                      : 'border-hairline bg-surface-2 text-text-muted',
              ].join(' ')}
            >
              {step.state === 'done' ? (
                <CheckIcon className="size-3" />
              ) : step.state === 'error' ? (
                '!'
              ) : (
                index + 1
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={[
                  'text-xs font-medium',
                  step.state === 'pending' ? 'text-text-muted' : 'text-text',
                ].join(' ')}
              >
                {step.label}
              </p>
              {step.transaction ? (
                <a
                  href={explorerTxUrl(
                    step.transaction.chain,
                    step.transaction.hash,
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 inline-block truncate font-mono text-[10px] text-text-muted underline decoration-hairline underline-offset-2 hover:text-lime"
                >
                  {truncateAddress(step.transaction.hash, 12, 8)}
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </GlassSheet>
  );
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  if (hours > 0) return `${hours.toString()}h ${minutes.toString()}m`;
  const secs = safe % 60;
  return `${minutes.toString()}m ${secs.toString()}s`;
}
