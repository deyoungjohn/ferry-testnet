import { PUSD_SYMBOL } from '../lib/config';
import { PUSD_BCH, USDC_BASE, type TokenMeta } from '../lib/tokens';
import { GlassModal } from './GlassModal';
import { CheckIcon } from './icons';

const OPTIONS: readonly TokenMeta[] = [USDC_BASE, PUSD_BCH];

export interface TokenPickerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly selected: TokenMeta;
  readonly onSelect?: (token: TokenMeta) => void;
}

export function TokenPicker({
  open,
  onOpenChange,
  selected,
  onSelect,
}: TokenPickerProps) {
  return (
    <GlassModal
      open={open}
      onOpenChange={onOpenChange}
      title="Select a token"
      description="Ferry routes settle on Bitcoin Cash. Choosing tPUSD on the send side flips the swap to the reverse direction."
    >
      <div className="space-y-2">
        {OPTIONS.map((option) => {
          const active =
            option.symbol === selected.symbol &&
            option.chainShort === selected.chainShort;
          return (
            <button
              key={`${option.chainShort}-${option.symbol}`}
              type="button"
              aria-pressed={active}
              onClick={() => {
                onSelect?.(option);
                onOpenChange(false);
              }}
              className={[
                'flex w-full items-center gap-3 rounded-well border px-3.5 py-3 text-left transition-colors',
                active
                  ? 'border-lime/35 bg-olive-soft/70'
                  : 'border-hairline bg-surface-2/70 hover:border-white/15',
              ].join(' ')}
            >
              <span
                className={[
                  'grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold',
                  active
                    ? 'bg-lime text-lime-ink'
                    : 'bg-surface-1 text-text ring-1 ring-hairline',
                ].join(' ')}
                aria-hidden="true"
              >
                {option.glyph}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-text">
                  {option.symbol}
                  {option.symbol === PUSD_SYMBOL ? ' · Bitcoin Cash' : ''}
                </span>
                <span className="block text-[11px] text-text-muted">
                  {option.name} on {option.chain}
                </span>
              </span>
              {active ? <CheckIcon className="size-4 text-lime" /> : null}
            </button>
          );
        })}
      </div>
    </GlassModal>
  );
}
