import { evmLockId, type Hex32 } from '@ferry/core';
import {
  buildClaimTransaction,
  buildRefundTransaction,
  deriveHtlcAddresses,
} from '@ferry/htlc-bch';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  BASE_EXPLORER_URL,
  BCH_ELECTRUM_URL,
  BCH_EXPLORER_URL,
  BCH_NETWORK,
  FERRY_HTLC_ADDRESS,
  PUSD_SYMBOL,
  explorerTxUrl,
} from '../lib/config';
import { addressFromLockingBytecode } from '../lib/bch/address';
import {
  ClaimSpentError,
  ClaimVerificationError,
  broadcastClaimIdempotent,
} from '../lib/bch/claim-broadcast';
import { loadSecret } from '../lib/vault';
import {
  buildRecoveryFile,
  bchParametersFromTerms,
  downloadRecoveryFile,
} from '../lib/recovery';
import { loadOrderRecord, saveOrderRecord } from '../lib/orders/store';
import { ElectrumClient } from '../recover/core';
import { useSolver } from '../lib/solver/context';
import { describeSolverError, type SolverFailure } from '../lib/solver/errors';
import { solverIsLive } from '../lib/solver/kind';
import type { OrderView } from '../lib/solver/types';
import { buildOrderViewModel, formatDuration } from '../lib/solver/view';
import { formatPusd, formatUsdc, truncateAddress } from '../lib/swap';
import { useWallets } from '../lib/wallet/context';
import { CheckIcon, ShieldIcon } from '../components/icons';

const StatusDrawer = lazy(async () => {
  const module = await import('../components/StatusDrawer');
  return { default: module.StatusDrawer };
});

const ORDER_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function SwapStatusPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const solver = useSolver();
  const { bch, evm } = useWallets();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<SolverFailure | null>(null);
  const [actionError, setActionError] = useState<SolverFailure | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [localFallback, setLocalFallback] = useState(false);
  const [localSolverLive, setLocalSolverLive] = useState(false);
  const [claimPhase, setClaimPhase] = useState<
    'idle' | 'claiming' | 'onchain' | 'stalled'
  >('idle');
  const [claimStartedAt, setClaimStartedAt] = useState<number | null>(null);
  const claimInFlight = useRef(false);
  const autoClaimFor = useRef<string | null>(null);
  const claimActionRef = useRef<() => Promise<void>>(async () => undefined);

  const id =
    orderId && ORDER_ID_PATTERN.test(orderId) ? (orderId as Hex32) : null;

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!id) return;
    let active = true;
    let timer = 0;

    const load = async () => {
      try {
        const next = await solver.getOrder(id);
        if (!active) return;
        setOrder(next);
        setError(null);
        setLocalFallback(false);
        void saveOrderRecord(next, solverIsLive());
      } catch (cause) {
        if (!active) return;
        const local = await loadOrderRecord(id);
        if (!active) return;
        if (local) {
          setOrder(local);
          setError(null);
          setLocalFallback(true);
          setLocalSolverLive(local.solverLive);
        } else {
          setError(describeSolverError(cause, 'Could not load this order'));
        }
      }
    };

    void load();
    timer = window.setInterval(
      () => void load(),
      claimPhase === 'idle' ? 2_000 : 3_000,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [claimPhase, id, solver]);

  useEffect(() => {
    autoClaimFor.current = null;
    claimInFlight.current = false;
    setClaimPhase('idle');
    setClaimStartedAt(null);
  }, [id]);

  const view = useMemo(
    () => (order ? buildOrderViewModel(order, now) : null),
    [order, now],
  );
  const reverse = order?.terms.direction === 'BCH_TO_COUNTER';
  const bchUserAddress = useMemo(
    () =>
      order
        ? addressFromLockingBytecode(order.terms.userBchLockingBytecode).address
        : '',
    [order],
  );

  useEffect(() => {
    if (
      (claimPhase === 'claiming' || claimPhase === 'onchain') &&
      claimStartedAt !== null &&
      now - claimStartedAt >= 90
    ) {
      setClaimPhase('stalled');
    }
  }, [claimPhase, claimStartedAt, now]);

  useEffect(() => {
    if (
      order?.status === 'USER_CLAIM_SEEN' ||
      order?.status === 'SOLVER_CLAIM_BROADCAST' ||
      order?.status === 'SOLVER_CLAIM_FINAL' ||
      order?.status === 'DONE'
    ) {
      setClaimPhase('idle');
      setClaimStartedAt(null);
    }
  }, [order?.status]);

  async function refresh(): Promise<void> {
    if (!id) return;
    const next = await solver.getOrder(id);
    setOrder(next);
  }

  function showActionFailure(cause: unknown, fallback: string): void {
    setActionError(describeSolverError(cause, fallback));
  }

  async function handleRecoveryDownload(): Promise<void> {
    if (!order) return;
    try {
      const secret = await loadSecret(order.orderId);
      if (!secret) {
        throw new Error(
          'No local recovery secret. This browser did not create the order.',
        );
      }
      downloadRecoveryFile(
        buildRecoveryFile(
          order.orderId,
          order.terms,
          secret,
          Math.floor(Date.now() / 1_000),
          (localFallback ? localSolverLive : solverIsLive()) ? 'live' : 'mock',
        ),
      );
      setActionMessage('Recovery file downloaded.');
    } catch (cause) {
      showActionFailure(cause, 'Could not prepare the recovery file');
    }
  }

  async function handleClaim(): Promise<void> {
    if (!id || !order || claimInFlight.current) return;
    claimInFlight.current = true;
    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    setClaimPhase('claiming');
    setClaimStartedAt(Math.floor(Date.now() / 1_000));
    try {
      const secret = await loadSecret(id);
      if (!secret) {
        throw new Error(
          'No local recovery secret. Open the recovery file on the device that created this swap.',
        );
      }
      if (!order.bchLockUtxo) {
        throw new Error('The solver BCH lock is not visible yet.');
      }
      const built = buildClaimTransaction({
        params: bchParametersFromTerms(order.terms),
        network: BCH_NETWORK,
        secret,
        utxo: {
          txid: order.bchLockUtxo.txid,
          vout: order.bchLockUtxo.vout,
          satoshis: order.bchLockUtxo.satoshis,
        },
        feeSats: 500n,
      });
      const result = await broadcastClaimIdempotent({
        broadcast: (txHex: string) => bch.broadcastTransaction(txHex),
        transactionExists: bch.transactionExists
          ? (txid) => bch.transactionExists!(txid)
          : async () => {
              throw new Error('BCH transaction lookup is unavailable');
            },
        txHex: built.txHex,
        expectedTxid: built.txid,
      });
      setClaimPhase('onchain');
      setActionMessage(
        result.already
          ? `BCH claim is already on chain: ${truncateAddress(result.txid, 10, 6)}. Waiting for the solver to release your USDC.`
          : `BCH claim broadcast: ${truncateAddress(result.txid, 10, 6)}. Waiting for the solver to release your USDC.`,
      );
      try {
        await solver.submitSecret(id, secret);
      } catch {
        setActionMessage(
          'Claim is on chain. The solver notification failed, but the solver can still detect the public claim.',
        );
      }
      await refresh();
    } catch (cause) {
      setClaimPhase('idle');
      setClaimStartedAt(null);
      if (cause instanceof ClaimSpentError) {
        setActionError({
          sentence: cause.message,
          nextStep: cause.nextStep,
          code: null,
          kind: 'local',
        });
      } else if (cause instanceof ClaimVerificationError) {
        setActionError({
          sentence: cause.message,
          nextStep: cause.nextStep,
          code: null,
          kind: 'local',
        });
      } else {
        showActionFailure(cause, 'Could not submit the claim');
      }
    } finally {
      claimInFlight.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    claimActionRef.current = handleClaim;
  });

  useEffect(() => {
    if (
      !id ||
      !order ||
      reverse ||
      !view?.claimAvailable ||
      autoClaimFor.current === id
    ) {
      return;
    }
    autoClaimFor.current = id;
    void claimActionRef.current();
  }, [id, order, reverse, view?.claimAvailable]);

  async function handleReverseClaim(gasless: boolean): Promise<void> {
    if (!id || !order) return;
    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const secret = await loadSecret(id);
      if (!secret) {
        throw new Error(
          'No local recovery secret. Open the recovery file on the device that created this swap.',
        );
      }
      if (gasless) {
        await solver.relayClaim(id, secret);
        setActionMessage(
          'USDC claim relayed. The solver pays the Base gas and the BCH side settles next.',
        );
      } else {
        if (!evm.address) {
          throw new Error('Connect the Base wallet that will receive USDC.');
        }
        const lockId = evmLockId(
          order.terms.solverCounterAddress,
          order.terms.hashLock,
        );
        const txHash = await evm.claimLock(lockId, secret);
        setActionMessage(
          `USDC claim submitted: ${truncateAddress(txHash, 10, 6)}`,
        );
      }
      await refresh();
    } catch (cause) {
      showActionFailure(cause, 'Could not claim USDC');
    } finally {
      setBusy(false);
    }
  }

  async function loadUserBchLockUtxo(): Promise<{
    readonly txid: string;
    readonly vout: number;
    readonly satoshis: bigint;
  }> {
    if (!order) throw new Error('Order is not loaded');
    if (order.bchLockUtxo) return order.bchLockUtxo;
    const addresses = deriveHtlcAddresses(
      bchParametersFromTerms(order.terms),
      BCH_NETWORK,
    );
    const electrum = new ElectrumClient(BCH_ELECTRUM_URL);
    try {
      await electrum.connect();
      const utxos = await electrum.listUnspent(
        `0x${Array.from(addresses.lockingBytecode, (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('')}`,
      );
      const category = order.terms.bchTokenCategory
        .toLowerCase()
        .replace(/^0x/, '');
      const match = utxos.find(
        (utxo) =>
          utxo.category?.toLowerCase().replace(/^0x/, '') === category &&
          utxo.amount === order.terms.bchTokenAmount,
      );
      if (!match) throw new Error('The BCH lock UTXO is not visible yet');
      return match;
    } finally {
      electrum.close();
    }
  }

  async function handleBchRefund(): Promise<void> {
    if (!order) return;
    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      if (order.bchTipError) {
        throw new Error(`BCH refund is disabled: ${order.bchTipError}`);
      }
      if (order.bchTipHeight < order.terms.bchRefundHeight) {
        throw new Error('The BCH refund height has not been reached yet');
      }
      const utxo = await loadUserBchLockUtxo();
      const built = buildRefundTransaction({
        params: bchParametersFromTerms(order.terms),
        network: BCH_NETWORK,
        utxo: {
          txid: utxo.txid,
          vout: utxo.vout,
          satoshis: utxo.satoshis,
        },
        feeSats: 500n,
      });
      const txid = await bch.broadcastTransaction(built.txHex);
      await refresh();
      setActionMessage(`BCH refund broadcast: ${truncateAddress(txid, 10, 6)}`);
    } catch (cause) {
      showActionFailure(cause, 'Could not refund the BCH lock');
    } finally {
      setBusy(false);
    }
  }

  async function handleRefund(): Promise<void> {
    if (!order) return;
    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      if (!evm.address) {
        throw new Error('Connect the Base wallet that made this lock first.');
      }
      const lockId = evmLockId(
        order.terms.userCounterAddress,
        order.terms.hashLock,
      );
      const txHash = await evm.refundLock(lockId);
      setActionMessage(`Refund submitted: ${truncateAddress(txHash, 10, 6)}`);
      await refresh();
    } catch (cause) {
      showActionFailure(cause, 'Could not refund the lock');
    } finally {
      setBusy(false);
    }
  }

  const sendAmount = order
    ? reverse
      ? `${formatPusd(order.terms.bchTokenAmount)} ${PUSD_SYMBOL}`
      : `${formatUsdc(order.terms.counterAmount)} USDC`
    : '';
  const receiveAmount = order
    ? reverse
      ? `${formatUsdc(order.terms.counterAmount)} USDC`
      : `${formatPusd(order.terms.bchTokenAmount)} ${PUSD_SYMBOL}`
    : '';

  if (!id) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
        <p className="text-xs font-medium tracking-[0.16em] text-text-muted uppercase">
          Swap status
        </p>
        <h1 className="mt-2 font-serif text-4xl italic text-text">
          That order link is incomplete.
        </h1>
        <p className="mt-3 text-sm text-text-muted">
          Open the status link from the swap receipt, or start a new swap.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex h-11 items-center rounded-pill bg-olive px-5 text-sm font-semibold text-text"
        >
          Start a swap
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-[0.16em] text-text-muted uppercase">
            Swap status
          </p>
          <h1 className="mt-1 font-serif text-3xl italic text-text sm:text-4xl">
            {view ? view.statusLabel : 'Reading the order…'}
          </h1>
        </div>
        <span className="rounded-pill border border-hairline bg-surface-2 px-3 py-1.5 font-mono text-[10px] text-text-muted">
          {truncateAddress(id, 10, 8)}
        </span>
      </div>

      {!solverIsLive() ? (
        <p
          role="note"
          className="mt-6 rounded-well border border-warn/25 bg-warn/5 px-4 py-3 text-[11px] leading-5 text-warn"
        >
          Mock interface — no funds move. This timeline is simulated; hashes are
          not on chain and explorer links are disabled.
        </p>
      ) : null}

      {localFallback && order ? (
        <section
          role="status"
          className="mt-6 rounded-well border border-warn/25 bg-warn/5 px-4 py-3 text-[11px] leading-5 text-warn"
        >
          <p className="font-medium">
            The solver has no record of this order (it may have been restarted).
          </p>
          <p className="mt-1">
            Showing the last record saved in this browser. The recovery file and
            recovery page remain available.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void handleRecoveryDownload()}
              className="rounded-pill border border-warn/30 bg-warn/10 px-3 py-1.5 font-medium text-warn"
            >
              Download recovery file
            </button>
            <Link to="/recover" className="underline underline-offset-2">
              Open recovery page
            </Link>
          </div>
        </section>
      ) : null}

      {error && !order ? (
        <div className="mt-8 rounded-card border border-danger/25 bg-danger/5 p-6">
          <p className="text-sm font-medium text-danger">{error.sentence}</p>
          {error.nextStep ? (
            <p className="mt-1 text-xs text-text-muted">{error.nextStep}</p>
          ) : null}
          {error.code ? (
            <p className="mt-1 font-mono text-[10px] text-text-muted">
              Code: {error.code}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-text-muted">
            Check the link, or open a swap you created in this browser.
          </p>
          <Link
            to="/"
            className="mt-5 inline-flex h-10 items-center rounded-pill bg-surface-3 px-4 text-xs font-medium text-text"
          >
            Start a swap
          </Link>
        </div>
      ) : null}

      {order?.bchTipError ? (
        <p
          role="alert"
          className="mt-6 rounded-well border border-warn/25 bg-warn/5 px-4 py-3 text-[11px] leading-5 text-warn"
        >
          BCH tip unavailable: {order.bchTipError}. Refund actions stay disabled
          until an independent Electrum tip is reachable.
        </p>
      ) : null}

      {order && view ? (
        <>
          <section className="mt-8 rounded-card border border-hairline bg-surface-1 p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] font-medium tracking-[0.14em] text-text-muted uppercase">
                  You send
                </p>
                <p className="mt-1 text-2xl font-medium tabular-nums text-text">
                  {sendAmount}
                </p>
                <p className="mt-1 text-[11px] text-text-muted">
                  {reverse ? 'on BCH · ' : 'on Base · '}
                  {reverse
                    ? truncateAddress(bchUserAddress, 12, 6)
                    : truncateAddress(order.terms.userCounterAddress)}
                </p>
              </div>
              <span className="text-2xl text-text-muted" aria-hidden="true">
                →
              </span>
              <div className="text-right">
                <p className="text-[10px] font-medium tracking-[0.14em] text-text-muted uppercase">
                  You receive
                </p>
                <p className="mt-1 text-2xl font-medium tabular-nums text-lime">
                  {receiveAmount}
                </p>
                <p className="mt-1 text-[11px] text-text-muted">
                  {reverse ? 'on Base · ' : 'on BCH · '}
                  {reverse
                    ? truncateAddress(order.terms.userCounterAddress)
                    : truncateAddress(bchUserAddress, 12, 6)}
                </p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 border-t border-hairline pt-4 text-[11px]">
              <div>
                <p className="text-text-muted">Base deadline</p>
                <p className="mt-0.5 font-medium tabular-nums text-text">
                  {formatDuration(view.counterTimeRemainingSeconds)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-text-muted">BCH refund</p>
                <p className="mt-0.5 font-medium tabular-nums text-text">
                  {view.blocksRemaining} blocks ·{' '}
                  {formatDuration(view.bchTimeRemainingSeconds)}
                </p>
              </div>
            </div>
            {order.bchLockUtxo ? (
              <p className="mt-3 truncate border-t border-hairline pt-3 font-mono text-[10px] text-text-muted">
                {reverse ? 'Your BCH lock' : 'BCH lock'}{' '}
                {truncateAddress(order.bchLockUtxo.txid, 12, 8)}:
                {order.bchLockUtxo.vout} ·{' '}
                {order.bchLockUtxo.satoshis.toString()} sats
              </p>
            ) : null}
          </section>

          {!reverse && claimPhase !== 'idle' ? (
            <section
              aria-live="polite"
              className="mt-5 rounded-card border border-hairline bg-surface-1 p-5 text-[11px] leading-5 text-text-muted sm:p-6"
            >
              {claimPhase === 'claiming' ? (
                <p className="text-sm font-medium text-text">
                  Claiming your tPUSD…
                </p>
              ) : claimPhase === 'onchain' ? (
                <p className="text-sm font-medium text-text">
                  Claim on chain, waiting for the solver to release your USDC.
                </p>
              ) : (
                <>
                  <p className="text-sm font-medium text-warn">
                    Your claim is on chain, but the solver has not released USDC
                    after 90 seconds.
                  </p>
                  <p className="mt-1">
                    Keep this page open; the solver can still detect the public
                    claim. If it does not, open Recovery.
                  </p>
                </>
              )}
            </section>
          ) : null}

          <section className="mt-5 rounded-card border border-hairline bg-surface-1 p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-text">Timeline</h2>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-text-muted">
                  {solverIsLive() ? 'Live solver' : 'Mock solver'} · updates
                  every 2s
                </span>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="rounded-pill border border-hairline bg-surface-2 px-2.5 py-1 text-[10px] font-medium text-text-muted transition-colors hover:border-lime/30 hover:text-lime"
                >
                  Open timeline drawer
                </button>
              </div>
            </div>
            <ol className="mt-4 space-y-0">
              {view.steps.map((step, index) => (
                <li
                  key={step.key}
                  className="relative flex gap-3 pb-5 last:pb-0"
                >
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
                        step.state === 'pending'
                          ? 'text-text-muted'
                          : 'text-text',
                      ].join(' ')}
                    >
                      {step.label}
                    </p>
                    {step.transaction && !solverIsLive() ? (
                      <span
                        title="Mock transaction: it does not exist on any chain"
                        className="mt-0.5 inline-block truncate font-mono text-[10px] text-text-muted"
                      >
                        {truncateAddress(step.transaction.hash, 12, 8)} (mock,
                        not on chain)
                      </span>
                    ) : step.transaction ? (
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
          </section>

          <section className="mt-5 rounded-card border border-hairline bg-surface-1 p-5 sm:p-6">
            {view.claimAvailable ? (
              <div>
                <h2 className="text-sm font-semibold text-text">
                  {reverse ? 'Claim your USDC' : 'Claim your tPUSD'}
                </h2>
                <p className="mt-1 text-[11px] leading-5 text-text-muted">
                  {reverse
                    ? 'The solver locked USDC on Base. Relay the claim gaslessly, or self-claim if the Base wallet holds ETH. The secret stays in this browser except for the relay request.'
                    : 'The solver locked tPUSD on BCH. Claiming reveals the secret on-chain; only then is it sent to the solver so it can settle USDC. The status endpoint never returns it.'}
                </p>
                {reverse ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleReverseClaim(true)}
                      disabled={busy}
                      className="mt-4 flex h-11 w-full items-center justify-center rounded-pill bg-olive px-5 text-sm font-semibold text-text shadow-pill disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy ? 'Relaying claim…' : 'Claim USDC (gasless)'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleReverseClaim(false)}
                      disabled={busy || !evm.address}
                      title={
                        !evm.address
                          ? 'Connect the Base wallet for a self-claim'
                          : undefined
                      }
                      className="mt-2 flex h-10 w-full items-center justify-center rounded-pill border border-hairline bg-surface-2 px-5 text-xs font-medium text-text disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Self-claim with Base wallet
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleClaim()}
                    disabled={busy || claimPhase === 'claiming'}
                    className="mt-4 flex h-11 w-full items-center justify-center rounded-pill bg-olive px-5 text-sm font-semibold text-text shadow-pill disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {claimPhase === 'claiming'
                      ? 'Claiming your tPUSD…'
                      : 'Claim tPUSD'}
                  </button>
                )}
                {reverse && !evm.address ? (
                  <button
                    type="button"
                    onClick={() => evm.connect()}
                    disabled={evm.status === 'unavailable'}
                    className="mt-2 text-[11px] text-text-muted underline decoration-hairline underline-offset-2 hover:text-lime disabled:opacity-40"
                  >
                    Connect Base wallet for self-claim
                  </button>
                ) : null}
              </div>
            ) : null}

            {view.refundAvailable || view.bchRefundAvailable ? (
              <div
                className={
                  view.claimAvailable
                    ? 'mt-5 border-t border-hairline pt-5'
                    : ''
                }
              >
                <h2 className="text-sm font-semibold text-text">
                  {reverse ? 'Refund your tPUSD' : 'Refund your USDC'}
                </h2>
                <p className="mt-1 text-[11px] leading-5 text-text-muted">
                  {reverse
                    ? 'The swap did not complete. After the BCH refund height, refund your own BCH lock to the wallet that funded it.'
                    : 'The swap did not complete. Refund the Base lock from the wallet that created it.'}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    reverse ? void handleBchRefund() : void handleRefund()
                  }
                  disabled={busy || (!reverse && !evm.address)}
                  title={
                    !reverse && !evm.address
                      ? 'Connect the Base wallet that made this lock'
                      : undefined
                  }
                  className="mt-4 flex h-11 w-full items-center justify-center rounded-pill border border-hairline bg-surface-2 px-5 text-sm font-semibold text-text disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy
                    ? 'Submitting refund…'
                    : reverse
                      ? 'Refund tPUSD'
                      : 'Refund USDC'}
                </button>
                {!reverse && !evm.address ? (
                  <button
                    type="button"
                    onClick={() => evm.connect()}
                    disabled={evm.status === 'unavailable'}
                    className="mt-2 text-[11px] text-text-muted underline decoration-hairline underline-offset-2 hover:text-lime disabled:opacity-40"
                  >
                    Connect Base wallet for self-claim
                  </button>
                ) : null}
              </div>
            ) : null}

            {!view.claimAvailable &&
            !view.refundAvailable &&
            !view.bchRefundAvailable ? (
              <div className="flex items-start gap-3">
                <span
                  className={[
                    'mt-1 size-2 shrink-0 rounded-full',
                    view.terminal
                      ? 'bg-text-muted'
                      : 'animate-pulse bg-lime shadow-[0_0_12px_var(--lime)]',
                  ].join(' ')}
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-medium text-text">
                    {view.terminal
                      ? view.statusLabel
                      : 'Waiting for the next step'}
                  </p>
                  <p className="mt-1 text-[11px] leading-5 text-text-muted">
                    {view.terminal
                      ? 'This order is closed. Keep the recovery file for your records.'
                      : 'Keep this page open. The timeline updates automatically.'}
                  </p>
                </div>
              </div>
            ) : null}

            {actionError ? (
              <div
                role="alert"
                className="mt-3 rounded-well border border-danger/25 bg-danger/5 px-3 py-2 text-[11px] leading-5 text-danger"
              >
                <p>{actionError.sentence}</p>
                {actionError.nextStep ? (
                  <p className="mt-1 text-text-muted">{actionError.nextStep}</p>
                ) : null}
                {actionError.code ? (
                  <p className="mt-1 font-mono text-[10px] text-text-muted">
                    Code: {actionError.code}
                  </p>
                ) : null}
              </div>
            ) : null}
            {actionMessage ? (
              <p role="status" className="mt-3 text-[11px] leading-5 text-ok">
                {actionMessage}
              </p>
            ) : null}
          </section>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-[11px] text-text-muted">
            <div className="flex items-center gap-3">
              {solverIsLive() ? (
                <>
                  <a
                    href={`${BCH_EXPLORER_URL}/address/${bchUserAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-lime"
                  >
                    BCH explorer
                  </a>
                  <a
                    href={`${BASE_EXPLORER_URL}/address/${FERRY_HTLC_ADDRESS}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-lime"
                  >
                    Base contract
                  </a>
                </>
              ) : (
                <span>Mock mode: explorer links disabled</span>
              )}
              <Link to="/recover" className="hover:text-lime">
                Recovery
              </Link>
            </div>
            <Link to="/" className="hover:text-lime">
              New swap
            </Link>
          </div>

          <p className="mt-4 flex items-center gap-1.5 text-[10px] text-text-muted">
            <ShieldIcon className="size-3.5 text-ok" />
            The secret is only revealed by the BCH claim; the status endpoint
            cannot supply it.
          </p>

          {drawerOpen ? (
            <Suspense fallback={null}>
              <StatusDrawer
                open
                onOpenChange={setDrawerOpen}
                view={view}
                orderId={id}
              />
            </Suspense>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
