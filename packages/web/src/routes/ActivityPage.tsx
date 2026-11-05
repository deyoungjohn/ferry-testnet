import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { createPublicClient, http, type PublicClient } from 'viem';
import { fetchChainLocks, type ChainLock } from '../lib/activity/chain';
import { mergeActivity, type ActivityEntry } from '../lib/activity/merge';
import {
  BASE_RPC_URL,
  explorerTxUrl,
  FERRY_HTLC_ADDRESS,
  FERRY_HTLC_DEPLOY_BLOCK,
  PUSD_SYMBOL,
} from '../lib/config';
import { useWallets } from '../lib/wallet/context';
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

// Base Sepolia produced about 500,000 blocks a day in November 2026; read a day at a time.
const SCAN_WINDOW = 500_000n;

function amounts(entry: ActivityEntry): string {
  if (entry.order) {
    const bch = `${formatPusd(entry.order.terms.bchTokenAmount)} ${PUSD_SYMBOL}`;
    const counter = `${formatUsdc(entry.order.terms.counterAmount)} USDC`;
    return entry.direction === 'BCH_TO_COUNTER'
      ? `${bch} → ${counter}`
      : `${counter} → ${bch}`;
  }
  const usdc = entry.chain ? `${formatUsdc(entry.chain.amount)} USDC` : '';
  return entry.direction === 'BCH_TO_COUNTER'
    ? `${PUSD_SYMBOL} → ${usdc}`
    : `${usdc} → ${PUSD_SYMBOL}`;
}

const CHAIN_STATE_LABEL: Readonly<Record<ChainLock['state'], string>> = {
  locked: 'USDC locked on Base',
  claimed: 'USDC claimed on Base',
  refunded: 'USDC refunded on Base',
};

function useChainLocks(address: string | null) {
  const [locks, setLocks] = useState<ChainLock[]>([]);
  const [scannedFrom, setScannedFrom] = useState<bigint | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<bigint | null>(null);

  const enabled = Boolean(address) && solverIsLive() && BASE_RPC_URL !== '';
  const floor = BigInt(FERRY_HTLC_DEPLOY_BLOCK);

  async function scan(user: string, reset: boolean) {
    setScanning(true);
    setError(null);
    try {
      const client: PublicClient = createPublicClient({
        transport: http(BASE_RPC_URL),
      });
      const head = latest ?? (await client.getBlockNumber());
      setLatest(head);
      const toBlock = reset || scannedFrom === null ? head : scannedFrom - 1n;
      let fromBlock = toBlock - SCAN_WINDOW;
      if (fromBlock < floor) fromBlock = floor;
      if (toBlock < fromBlock) {
        setScannedFrom(floor);
        return;
      }
      const found = await fetchChainLocks({
        client,
        htlc: FERRY_HTLC_ADDRESS,
        user: user as `0x${string}`,
        fromBlock,
        toBlock,
      });
      setScannedFrom(fromBlock);
      setLocks((previous) => {
        const byId = new Map(
          (reset ? [] : previous).map((lock) => [lock.id, lock]),
        );
        for (const lock of found) byId.set(lock.id, lock);
        return [...byId.values()];
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not read the chain',
      );
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    setLocks([]);
    setScannedFrom(null);
    setLatest(null);
    if (enabled && address) void scan(address, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, enabled]);

  return {
    enabled,
    locks,
    scanning,
    error,
    canLoadOlder:
      enabled && scannedFrom !== null && scannedFrom > floor && floor > 0n,
    loadOlder: () => (address ? scan(address, false) : Promise.resolve()),
    scannedFrom,
    reachedStart: scannedFrom !== null && scannedFrom <= floor,
  };
}

export function ActivityPage() {
  const { evm } = useWallets();
  const [orders, setOrders] = useState<PersistedOrder[] | null>(null);
  const [page, setPage] = useState(0);
  const chain = useChainLocks(evm.address);

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

  const all = orders === null ? [] : mergeActivity(orders, chain.locks);
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
        Read from the chain for your connected Base wallet, plus the orders
        saved in this browser. Orders made on another device show their Base
        side only.
      </p>

      {solverIsLive() && !evm.address ? (
        <p
          role="note"
          className="mt-4 rounded-well border border-hairline bg-surface-1 px-4 py-3 text-[11px] leading-5 text-text-muted"
        >
          Connect your Base wallet to load your activity from the chain on any
          device.
        </p>
      ) : null}
      {chain.scanning ? (
        <p role="status" className="mt-4 text-[11px] text-text-muted">
          Reading Base for your locks…
        </p>
      ) : null}
      {chain.error ? (
        <p
          role="alert"
          className="mt-4 rounded-well border border-warn/25 bg-warn/5 px-4 py-3 text-[11px] leading-5 text-warn"
        >
          Could not read the chain: {chain.error}. Showing this browser’s saved
          orders.
        </p>
      ) : null}

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
            {visible.map((entry) => {
              const source = entry.order
                ? loadOrderSource(entry.order.orderId)
                : 'swap';
              const label = entry.order
                ? buildOrderViewModel(entry.order).statusLabel
                : entry.chain
                  ? CHAIN_STATE_LABEL[entry.chain.state]
                  : '';
              const links: Array<{
                key: string;
                chain: 'base' | 'bch';
                label: string;
                hash: string;
              }> = (entry.order?.transactions ?? []).map((tx) => ({
                key: `${tx.label}-${tx.hash}`,
                chain: tx.chain,
                label: tx.label,
                hash: tx.hash,
              }));
              if (entry.chain) {
                const known = new Set(
                  links.map((link) => link.hash.toLowerCase()),
                );
                if (!known.has(entry.chain.lockTx.toLowerCase())) {
                  links.push({
                    key: `lock-${entry.chain.lockTx}`,
                    chain: 'base',
                    label: 'Base lock',
                    hash: entry.chain.lockTx,
                  });
                }
                if (
                  entry.chain.settleTx &&
                  !known.has(entry.chain.settleTx.toLowerCase())
                ) {
                  links.push({
                    key: `settle-${entry.chain.settleTx}`,
                    chain: 'base',
                    label:
                      entry.chain.state === 'claimed'
                        ? 'Base claim'
                        : 'Base refund',
                    hash: entry.chain.settleTx,
                  });
                }
              }
              return (
                <li
                  key={entry.key}
                  className="rounded-card border border-hairline bg-surface-1 p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-medium tracking-[0.14em] text-text-muted uppercase">
                        {SOURCE_LABEL[source]} ·{' '}
                        <time
                          dateTime={new Date(
                            entry.createdAt * 1_000,
                          ).toISOString()}
                        >
                          {formatUtcTimestamp(entry.createdAt)}
                        </time>
                      </p>
                      <p className="mt-2 text-sm font-medium tabular-nums text-text">
                        {amounts(entry)}
                      </p>
                    </div>
                    <span className="rounded-pill border border-hairline bg-surface-2 px-3 py-1 text-[11px] text-text-muted">
                      {label}
                    </span>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline pt-3 text-[11px]">
                    {entry.order ? (
                      <Link
                        to={`/swap/${entry.order.orderId}`}
                        className="text-text underline decoration-hairline underline-offset-4 hover:text-lime"
                      >
                        Open status
                      </Link>
                    ) : (
                      <span className="text-text-muted">
                        From the chain · BCH side not saved on this device
                      </span>
                    )}
                    {links.map((link) => (
                      <a
                        key={link.key}
                        href={explorerTxUrl(link.chain, link.hash)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[10px] text-text-muted underline decoration-hairline underline-offset-4 hover:text-lime"
                      >
                        {link.label} · {truncateAddress(link.hash, 8, 6)} ↗
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

      {chain.canLoadOlder ? (
        <button
          type="button"
          onClick={() => void chain.loadOlder()}
          disabled={chain.scanning}
          className="mt-6 rounded-pill border border-hairline bg-surface-2 px-4 py-2 text-[11px] text-text disabled:opacity-50"
        >
          {chain.scanning ? 'Reading…' : 'Load older activity'}
        </button>
      ) : null}
    </div>
  );
}
