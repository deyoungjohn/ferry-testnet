import { lazy, Suspense, useState } from 'react';
import type { TokenMeta } from '../lib/tokens';
import { ChevronDownIcon, LockIcon } from './icons';

const TokenPicker = lazy(async () => {
  const module = await import('./TokenPicker');
  return { default: module.TokenPicker };
});

export interface TokenPillProps {
  readonly token: TokenMeta;
  readonly pinned?: boolean;
  readonly onSelect?: (token: TokenMeta) => void;
}

export function TokenPill({ token, pinned = false, onSelect }: TokenPillProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const glyph = token.glyph;

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
        title={`${token.chain} side is pinned by the swap direction`}
      >
        {inner}
        <LockIcon className="size-3 shrink-0 text-lime" />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        onClick={() => setPickerOpen(true)}
        className="flex shrink-0 items-center gap-2 rounded-pill bg-surface-3 py-1.5 pr-2.5 pl-1.5 ring-1 ring-hairline transition-colors hover:ring-white/15"
      >
        {inner}
        <ChevronDownIcon className="size-3.5 shrink-0 text-text-muted" />
      </button>
      {pickerOpen ? (
        <Suspense fallback={null}>
          <TokenPicker
            open
            onOpenChange={setPickerOpen}
            selected={token}
            {...(onSelect ? { onSelect } : {})}
          />
        </Suspense>
      ) : null}
    </>
  );
}
