import { MOCK_SWAP } from '../lib/mock/swap';
import { ArrowUpDownIcon, ShieldIcon } from './icons';
import { TokenPill } from './TokenPill';
import { Well } from './Well';

export function SwapCard() {
  const { send, receive, quote } = MOCK_SWAP;

  return (
    <section
      aria-labelledby="swap-title"
      className="card-ring relative w-full max-w-[30rem] rounded-card border border-hairline bg-surface-1 p-5 sm:p-6"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 id="swap-title" className="text-sm font-semibold tracking-tight">
            Swap
          </h2>
          <span className="rounded-pill bg-olive-soft px-2 py-0.5 text-[9px] font-medium tracking-[0.14em] text-lime uppercase ring-1 ring-lime/15">
            Mock quote
          </span>
        </div>
        <div
          role="group"
          aria-label="Lane"
          className="flex shrink-0 items-center gap-0.5 rounded-pill bg-surface-2 p-0.5 text-[10px] ring-1 ring-hairline"
        >
          <span
            className="rounded-pill px-2 py-1 text-text-muted"
            aria-disabled="true"
            title="Fast lane is limited to swaps under $25"
          >
            Fast ≤ $25
          </span>
          <span className="rounded-pill bg-surface-3 px-2 py-1 font-medium text-text ring-1 ring-hairline">
            Safe
          </span>
        </div>
      </div>

      <div className="mt-5">
        <Well
          label={send.label}
          amount={send.amount}
          fiat={send.fiat}
          balance={send.balance}
          selector={<TokenPill token={send.token} />}
        />

        <div className="relative z-10 -my-2.5 flex justify-center">
          <button
            type="button"
            aria-label="Switch direction — reverse flow lands in L5"
            aria-disabled="true"
            title="Reverse direction lands in L5"
            className="grid size-10 place-items-center rounded-full border-4 border-surface-1 bg-surface-3 text-text-muted shadow-pill transition-colors hover:text-lime"
          >
            <ArrowUpDownIcon className="size-4" />
          </button>
        </div>

        <Well
          label={receive.label}
          amount={receive.amount}
          fiat={receive.fiat}
          balance={receive.balance}
          selector={<TokenPill token={receive.token} pinned />}
        />
      </div>

      <dl className="mt-5 divide-y divide-hairline border-y border-hairline text-xs">
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-text-muted">Rate</dt>
          <dd className="text-right font-medium tabular-nums text-text">
            {quote.rate}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-text-muted">Spread</dt>
          <dd className="font-medium tabular-nums text-text">{quote.spread}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-text-muted">Fixed fee</dt>
          <dd className="font-medium tabular-nums text-text">{quote.fee}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-text-muted">Arrival</dt>
          <dd className="text-right text-text">{quote.lane}</dd>
        </div>
      </dl>

      <button
        type="button"
        aria-disabled="true"
        title="Swap wiring lands in L5"
        className="mt-5 flex h-13 w-full items-center justify-center gap-1.5 rounded-pill bg-olive px-5 text-sm font-semibold text-text shadow-pill transition-[filter,transform] hover:brightness-110 active:translate-y-px"
      >
        Ferry it
        <span aria-hidden="true" className="text-base leading-none">
          ›
        </span>
      </button>

      <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-text-muted">
        <ShieldIcon className="size-3.5 text-ok" />
        Refunds are automatic if the swap stalls.
      </p>
    </section>
  );
}
