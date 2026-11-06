import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { createPublicClient, http, type PublicClient } from 'viem';
import { fetchBchActivity, type BchActivityItem } from '../lib/activity/bch';
import { fetchChainLocks, type ChainLock } from '../lib/activity/chain';
import { mergeActivity, type ActivityEntry } from '../lib/activity/merge';
import { parseBchAddress } from '../lib/bch/address';
import { ElectrumClient } from '../recover/core';
import {
  BASE_RPC_URL,
  BCH_ELECTRUM_URL,
  MUSD_CATEGORY,
  PUSD_CATEGORY,
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

const BCH_STATE_LABEL: Readonly<Record<BchActivityItem['state'], string>> = {
  received: `${PUSD_SYMBOL} received`,
  claimed: `${PUSD_SYMBOL} locked and claimed by the solver`,
  refunded: `${PUSD_SYMBOL} refunded to you`,
  locked: `${PUSD_SYMBOL} locked, waiting for the solver`,
};

const CHAIN_STATE_LABEL: Readonly<Record<ChainLock['state'], string>> = {
  locked: 'USDC locked on Base',
  claimed: 'USDC claimed on Base',
  refunded: 'USDC refunded on Base',
};

function amounts(entry: ActivityEntry): string {
  const bchAmount = entry.order
    ? entry.order.terms.bchTokenAmount
    : (entry.bch?.tokenAmount ?? null);
  const bch =
    bchAmount === null
      ? PUSD_SYMBOL
      : `${formatPusd(bchAmount)} ${PUSD_SYMBOL}`;
  const counterAmount = entry.order
    ? entry.order.terms.counterAmount
    : (entry.chain?.amount ?? null);
  const counter =
    counterAmount === null ? 'USDC' : `${formatUsdc(counterAmount)} USDC`;
  return entry.direction === 'BCH_TO_COUNTER'
    ? `${bch} → ${counter}`
    : `${counter} → ${bch}`;
}

function entryLabel(entry: ActivityEntry): string {
  if (entry.order) return buildOrderViewModel(entry.order).statusLabel;
  if (entry.bch) return BCH_STATE_LABEL[entry.bch.state];
  if (entry.chain) return CHAIN_STATE_LABEL[entry.chain.state];
  return '';
}

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

const BCH_PAGE = 30;

function useBchActivity(lockingBytecode: string | null) {
  const [items, setItems] = useState<BchActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [limit, setLimit] = useState(BCH_PAGE);

  useEffect(() => {
    setLimit(BCH_PAGE);
  }, [lockingBytecode]);

  useEffect(() => {
    if (!lockingBytecode || !solverIsLive() || BCH_ELECTRUM_URL === '') {
      setItems([]);
      setMore(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    const electrum = new ElectrumClient(BCH_ELECTRUM_URL);
    void (async () => {
      try {
        await electrum.connect();
        const result = await fetchBchActivity({
          electrum,
          userLockingBytecode: lockingBytecode,
          categories: [PUSD_CATEGORY, MUSD_CATEGORY].filter(Boolean),
          limit,
        });
        if (!active) return;
        setItems(result.items);
        setMore(result.readTransactions < result.totalTransactions);
      } catch (cause) {
        if (active) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not read Bitcoin Cash',
          );
        }
      } finally {
        electrum.close();
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      electrum.close();
    };
  }, [lockingBytecode, limit]);

  return {
    items,
    loading,
    error,
    canLoadMore: more,
    loadMore: () => setLimit((current) => current + BCH_PAGE),
  };
}

export function ActivityPage() {
  const { evm, bch: bchWallet } = useWallets();
  const [orders, setOrders] = useState<PersistedOrder[] | null>(null);
  const [page, setPage] = useState(0);
  const [lookupInput, setLookupInput] = useState('');
  const [lookupBytecode, setLookupBytecode] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const walletBytecode = bchWallet.address?.lockingBytecode ?? null;
  const bytecode = lookupBytecode ?? walletBytecode;
  const bchActivity = useBchActivity(bytecode);
  const chain = useChainLocks(evm.address);

  function handleLookup(event: FormEvent): void {
    event.preventDefault();
    const text = lookupInput.trim();
    if (text === '') {
      setLookupBytecode(null);
      setLookupError(null);
      return;
    }
    const parsed = parseBchAddress(text);
    if (!parsed.ok) {
      setLookupError(parsed.error);
      return;
    }
    setLookupError(null);
    setPage(0);
    setLookupBytecode(parsed.value.lockingBytecode);
  }

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

  const all =
    orders === null
      ? []
      : mergeActivity({
          bch: bchActivity.items,
          orders: lookupBytecode ? [] : orders,
          locks: lookupBytecode ? [] : chain.locks,
        });
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
        Rebuilt from Bitcoin Cash for your BCH address: every claim, lock and
        refund Ferry made for you. Counter-chain details (Base) are added when
        your Base wallet is connected, and orders saved in this browser fill in
        the rest.
      </p>

      <form onSubmit={handleLookup} className="mt-5 flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="activity-address">
          BCH address
        </label>
        <input
          id="activity-address"
          value={lookupInput}
          onChange={(event) => setLookupInput(event.target.value)}
          placeholder={
            walletBytecode
              ? 'Using your connected BCH wallet. Paste another BCH address to look it up'
              : 'Paste a BCH address, or connect your BCH wallet'
          }
          className="min-w-0 flex-1 rounded-pill border border-hairline bg-surface-2 px-4 py-2 font-mono text-[11px] text-text placeholder:text-text-muted"
        />
        <button
          type="submit"
          className="rounded-pill border border-hairline bg-surface-2 px-4 py-2 text-[11px] text-text"
        >
          {lookupInput.trim() === '' && lookupBytecode
            ? 'Use my wallet'
            : 'Look up'}
        </button>
      </form>
      {lookupError ? (
        <p role="alert" className="mt-2 text-[11px] text-warn">
          {lookupError}
        </p>
      ) : null}

      {solverIsLive() && !bytecode ? (
        <p
          role="note"
          className="mt-4 rounded-well border border-hairline bg-surface-1 px-4 py-3 text-[11px] leading-5 text-text-muted"
        >
          Connect your BCH wallet or paste a BCH address to load your activity
          from Bitcoin Cash on any device.
        </p>
      ) : null}
      {bchActivity.loading || chain.scanning ? (
        <p role="status" className="mt-4 text-[11px] text-text-muted">
          {bchActivity.loading
            ? 'Reading Bitcoin Cash for your address…'
            : 'Reading Base for your locks…'}
        </p>
      ) : null}
      {bchActivity.error || chain.error ? (
        <p
          role="alert"
          className="mt-4 rounded-well border border-warn/25 bg-warn/5 px-4 py-3 text-[11px] leading-5 text-warn"
        >
          {bchActivity.error
            ? `Could not read Bitcoin Cash: ${bchActivity.error}.`
            : `Could not read Base: ${chain.error}.`}{' '}
          Showing what is available.
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
              const links: Array<{
                key: string;
                chain: 'base' | 'bch';
                label: string;
                hash: string;
              }> = (entry.bch?.txs ?? []).map((tx) => ({
                key: `bch-${tx.hash}`,
                chain: 'bch',
                label: tx.label,
                hash: tx.hash,
              }));
              const known = new Set(
                links.map((link) => link.hash.toLowerCase()),
              );
              for (const tx of entry.order?.transactions ?? []) {
                if (known.has(tx.hash.toLowerCase())) continue;
                known.add(tx.hash.toLowerCase());
                links.push({
                  key: `${tx.label}-${tx.hash}`,
                  chain: tx.chain,
                  label: tx.label,
                  hash: tx.hash,
                });
              }
              if (entry.chain) {
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
                      {entryLabel(entry)}
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
                    ) : null}
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

      {bchActivity.canLoadMore ? (
        <button
          type="button"
          onClick={bchActivity.loadMore}
          disabled={bchActivity.loading}
          className="mt-6 rounded-pill border border-hairline bg-surface-2 px-4 py-2 text-[11px] text-text disabled:opacity-50"
        >
          {bchActivity.loading ? 'Reading…' : 'Load older activity'}
        </button>
      ) : null}
      {chain.canLoadOlder && !lookupBytecode ? (
        <button
          type="button"
          onClick={() => void chain.loadOlder()}
          disabled={chain.scanning}
          className="mt-6 ml-3 rounded-pill border border-hairline bg-surface-2 px-4 py-2 text-[11px] text-text-muted disabled:opacity-50"
        >
          {chain.scanning ? 'Reading…' : 'Load older Base activity'}
        </button>
      ) : null}
    </div>
  );
}
