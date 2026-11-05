import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { explorerTxUrl, PUSD_SYMBOL } from '../lib/config';
import { formatUtcTimestamp } from '../lib/format';
import { loadOrderSource, type OrderSource } from '../lib/orders/context';
import { listOrderRecords, type PersistedOrder } from '../lib/orders/store';
import { solverIsLive } from '../lib/solver/kind';
import { buildOrderViewModel } from '../lib/solver/view';
import { formatPusd, formatUsdc, truncateAddress } from '../lib/swap';

export const ACTIVITY_PAGE_SIZE = 10;

const SOURCE_LABEL: Readonly<Record<OrderSource, string>> = {
  swap: 'Swap',
  invoice: 'Invoice payment',
  tip: 'Tip',
};

function amounts(order: PersistedOrder): string {
  const bch = `${formatPusd(order.terms.bchTokenAmount)} ${PUSD_SYMBOL}`;
  const counter = `${formatUsdc(order.terms.counterAmount)} USDC`;
  return order.terms.direction === 'BCH_TO_COUNTER'
    ? `${bch} → ${counter}`
    : `${counter} → ${bch}`;
}

export function ActivityPage() {
  const [orders, setOrders] = useState<PersistedOrder[] | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let active = true;
    void listOrderRecords()
      .then((records) => {
        if (!active) return;
        const live = solverIsLive();
        setOrders(records.filter((record) => record.solverLive === live));
      })
      .catch(() => {
        if (active) setOrders([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const all = orders ?? [];
  const pageCount = Math.max(1, Math.ceil(all.length / ACTIVITY_PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = all.slice(
    current * ACTIVITY_PAGE_SIZE,
    (current + 1) * ACTIVITY_PAGE_SIZE,
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-12 pb-20 sm:px-6">
      <p className="text-[10px] font-semibold tracking-[0.2em] text-lime uppercase">
        My Activity
      </p>
      <h1 className="mt-3 text-3xl font-medium tracking-[-0.04em] text-text sm:text-4xl">
        Your swaps and payments
      </h1>
      <p className="mt-3 text-sm leading-6 text-text-muted">
        Everything you made from this browser, with explorer links. It is stored
        on this device only.
      </p>

      {orders === null ? (
        <p role="status" className="mt-8 text-sm text-text-muted">
          Loading your activity…
        </p>
      ) : all.length === 0 ? (
        <div
          role="status"
          className="mt-8 rounded-card border border-hairline bg-surface-1 px-5 py-10 text-center text-sm text-text-muted"
        >
          Nothing here yet.{' '}
          <Link to="/" className="underline underline-offset-2">
            Start a swap
          </Link>
          .
        </div>
      ) : (
        <>
          <ul className="mt-8 space-y-3">
            {visible.map((order) => {
              const view = buildOrderViewModel(order);
              const source = loadOrderSource(order.orderId);
              return (
                <li
                  key={order.orderId}
                  className="rounded-card border border-hairline bg-surface-1 p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-medium tracking-[0.14em] text-text-muted uppercase">
                        {SOURCE_LABEL[source]} ·{' '}
                        <time
                          dateTime={new Date(
                            order.createdAt * 1_000,
                          ).toISOString()}
                        >
                          {formatUtcTimestamp(order.createdAt)}
                        </time>
                      </p>
                      <p className="mt-2 text-sm font-medium tabular-nums text-text">
                        {amounts(order)}
                      </p>
                    </div>
                    <span className="rounded-pill border border-hairline bg-surface-2 px-3 py-1 text-[11px] text-text-muted">
                      {view.statusLabel}
                    </span>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline pt-3 text-[11px]">
                    <Link
                      to={`/swap/${order.orderId}`}
                      className="text-text underline decoration-hairline underline-offset-4 hover:text-lime"
                    >
                      Open status
                    </Link>
                    {order.transactions.map((tx) => (
                      <a
                        key={`${tx.label}-${tx.hash}`}
                        href={explorerTxUrl(tx.chain, tx.hash)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[10px] text-text-muted underline decoration-hairline underline-offset-4 hover:text-lime"
                      >
                        {tx.label} · {truncateAddress(tx.hash, 8, 6)} ↗
                      </a>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>

          {pageCount > 1 ? (
            <nav
              aria-label="Activity pages"
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
    </div>
  );
}
