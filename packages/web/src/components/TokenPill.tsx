import type { MockToken } from '../lib/mock/swap';
import { ChevronDownIcon, LockIcon } from './icons';

export interface TokenPillProps {
  readonly token: MockToken;
  readonly pinned?: boolean;
}

export function TokenPill({ token, pinned = false }: TokenPillProps) {
  const glyph = token.symbol === 'PUSD' ? '₿' : '$';

  const inner = (
    <>
      <span
        className={[
          'grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
          pinned
            ? 'bg-lime text-lime-ink'
            : 'bg-surface-1 text-text ring-1 ring-hairline',
        ].join(' ')}
        aria-hidden="true"
      >
        {glyph}
      </span>
      <span className="min-w-0 text-left">
        <span className="block text-sm font-medium leading-tight text-text">
          {token.symbol}
        </span>
        <span className="block text-[10px] leading-tight text-text-muted">
          {token.chain}
        </span>
      </span>
    </>
  );

  if (pinned) {
    return (
      <div
        className="flex shrink-0 items-center gap-2 rounded-pill bg-olive-soft py-1.5 pr-3 pl-1.5 ring-1 ring-lime/15"
        title={`${token.chain} side is pinned in the scaffold`}
      >
        {inner}
        <LockIcon className="size-3 shrink-0 text-lime" />
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-disabled="true"
      title="Token and chain picker lands in L5"
      className="flex shrink-0 items-center gap-2 rounded-pill bg-surface-3 py-1.5 pr-2.5 pl-1.5 ring-1 ring-hairline transition-colors hover:ring-white/15"
    >
      {inner}
      <ChevronDownIcon className="size-3.5 shrink-0 text-text-muted" />
    </button>
  );
}
