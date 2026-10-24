import type { ReactNode } from 'react';

export interface WellProps {
  readonly label: string;
  readonly amount: string;
  readonly fiat: string;
  readonly balance: string;
  readonly selector: ReactNode;
  readonly editable?: boolean;
  readonly onAmountChange?: (value: string) => void;
  readonly disabled?: boolean;
}

export function Well({
  label,
  amount,
  fiat,
  balance,
  selector,
  editable = false,
  onAmountChange,
  disabled = false,
}: WellProps) {
  return (
    <div className="rounded-well bg-surface-2 p-4 ring-1 ring-hairline sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-text-muted">{label}</span>
        <span className="truncate text-[11px] text-text-muted">
          Balance {balance}
        </span>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editable ? (
            <input
              aria-label={`${label} amount`}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              disabled={disabled}
              onChange={(event) => onAmountChange?.(event.target.value)}
              className="w-full min-w-0 bg-transparent text-[2rem] font-medium leading-none tracking-[-0.035em] tabular-nums text-text outline-none disabled:text-text-muted sm:text-[2.25rem]"
            />
          ) : (
            <p className="truncate text-[2rem] font-medium leading-none tracking-[-0.035em] tabular-nums sm:text-[2.25rem]">
              {amount}
            </p>
          )}
          <p className="mt-2 text-xs tabular-nums text-text-muted">{fiat}</p>
        </div>
        {selector}
      </div>
    </div>
  );
}
