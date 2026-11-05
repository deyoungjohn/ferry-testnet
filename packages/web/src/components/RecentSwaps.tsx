import { useState } from 'react';
import { explorerTxUrl } from '../lib/config';
import { formatBaseUnits, formatUtcTimestamp } from '../lib/format';
import { formatDuration } from '../lib/solver/view';
import type { DataResource, RecentSwap } from '../lib/stats/types';
import { truncateAddress } from '../lib/swap';

export const RECENT_SWAPS_PAGE_SIZE = 10;

function swapLabel(swap: RecentSwap): string {
  const counter = `${formatBaseUnits(swap.counterAmount, swap.counterDecimals)} ${swap.counterSymbol}`;
  const bch = `${formatBaseUnits(swap.bchTokenAmount, swap.bchDecimals)} ${swap.bchSymbol}`;
  return swap.direction === 'COUNTER_TO_BCH'
    ? `${counter} → ${bch}`
    : `${bch} → ${counter}`;
}

function ProofLinks({ swap }: { readonly swap: RecentSwap }) {
  return (
    <span className="inline-flex items-center gap-3 text-[11px]">
      <a
        href={explorerTxUrl('base', swap.baseTxId)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Base transaction for ${truncateAddress(swap.orderId, 10, 6)}`}
        className="text-text-muted underline decoration-hairline underline-offset-4 hover:text-lime"
      >
        Base ↗
      </a>
      <a
        href={explorerTxUrl('bch', swap.bchTxId)}
        target="_blank"
        rel="noreferrer"
        aria-label={`BCH transaction for ${truncateAddress(swap.orderId, 10, 6)}`}
        className="text-text-muted underline decoration-hairline underline-offset-4 hover:text-lime"
      >
        BCH ↗
      </a>
    </span>
  );
}

export function RecentSwaps({
  resource,
}: {
  readonly resource: DataResource<readonly RecentSwap[]>;
}) {
  const all = resource.status === 'ready' ? resource.data : [];
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(all.length / RECENT_SWAPS_PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const swaps = all.slice(
    current * RECENT_SWAPS_PAGE_SIZE,
    (current + 1) * RECENT_SWAPS_PAGE_SIZE,
  );
  const emptyMessage =
    resource.status === 'loading'
      ? 'Loading recent settlements…'
      : resource.status === 'error'
        ? 'Recent swaps are unavailable right now.'
        : 'No completed swaps yet. Settlements will appear here with both explorer proofs.';

  return (
    <section
      id="recent-swaps"
      aria-labelledby="recent-swaps-heading"
      className="mt-24 border-t border-hairline pt-12"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-medium tracking-[0.18em] text-lime uppercase">
            Public trail
          </p>
          <h2
            id="recent-swaps-heading"
            className="mt-3 text-2xl font-medium tracking-[-0.03em] text-text sm:text-3xl"
          >
            Recent swaps
          </h2>
        </div>
        <p className="text-[11px] text-text-muted">
          One settlement, two chain proofs
        </p>
      </div>

      {swaps.length === 0 ? (
        <div
          className="mt-7 rounded-card border border-hairline bg-surface-1 px-5 py-10 text-center text-sm text-text-muted"
          role="status"
        >
          {emptyMessage}
        </div>
      ) : (
        <>
          <div className="mt-7 hidden overflow-hidden rounded-card border border-hairline bg-surface-1 md:block">
            <table className="w-full table-fixed text-left text-xs">
              <thead className="border-b border-hairline text-[10px] tracking-[0.14em] text-text-muted uppercase">
                <tr>
                  <th scope="col" className="w-[22%] px-5 py-3 font-medium">
                    Time
                  </th>
                  <th scope="col" className="w-[38%] px-5 py-3 font-medium">
                    Amounts
                  </th>
                  <th scope="col" className="w-[18%] px-5 py-3 font-medium">
                    Duration
                  </th>
                  <th scope="col" className="w-[22%] px-5 py-3 font-medium">
                    Proof
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {swaps.map((swap) => (
                  <tr key={swap.orderId}>
                    <td className="px-5 py-4 text-text-muted">
                      <time
                        dateTime={new Date(
                          swap.settledAt * 1_000,
                        ).toISOString()}
                      >
                        {formatUtcTimestamp(swap.settledAt)}
                      </time>
                    </td>
                    <td className="px-5 py-4 font-medium text-text tabular-nums">
                      {swapLabel(swap)}
                    </td>
                    <td className="px-5 py-4 text-text tabular-nums">
                      {formatDuration(swap.durationSeconds)}
                    </td>
                    <td className="px-5 py-4">
                      <ProofLinks swap={swap} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="mt-7 space-y-3 md:hidden">
            {swaps.map((swap) => (
              <li
                key={swap.orderId}
                className="rounded-card border border-hairline bg-surface-1 p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <time
                    dateTime={new Date(swap.settledAt * 1_000).toISOString()}
                    className="text-[11px] text-text-muted"
                  >
                    {formatUtcTimestamp(swap.settledAt)}
                  </time>
                  <span className="text-[11px] text-text-muted tabular-nums">
                    {formatDuration(swap.durationSeconds)}
                  </span>
                </div>
                <p className="mt-3 text-sm font-medium text-text tabular-nums">
                  {swapLabel(swap)}
                </p>
                <div className="mt-4 border-t border-hairline pt-3">
                  <ProofLinks swap={swap} />
                </div>
              </li>
            ))}
          </ul>

          {pageCount > 1 ? (
            <nav
              aria-label="Recent swaps pages"
              className="mt-5 flex items-center justify-between text-[11px] text-text-muted"
            >
              <button
                type="button"
                onClick={() => setPage(current - 1)}
                disabled={current === 0}
                className="rounded-pill border border-hairline px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <span className="tabular-nums">
                Page {current + 1} of {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPage(current + 1)}
                disabled={current >= pageCount - 1}
                className="rounded-pill border border-hairline px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
}
