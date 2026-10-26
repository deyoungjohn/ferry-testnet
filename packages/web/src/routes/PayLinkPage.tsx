import type { PayLink, PayLinkQuoteRequest } from '@ferry/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { chunkCashaddr } from '../lib/paylink/link';
import type { SignedQuote } from '../lib/solver/types';
import {
  assertPayLinkQuote,
  assertTimingInvariant,
  isQuoteExpired,
  verifySignedQuote,
  type TermsCheckConfig,
} from '../lib/solver/verify';
import { formatDuration } from '../lib/solver/view';
import {
  buildRecoveryFile,
  downloadRecoveryFile,
  type RecoveryFile,
} from '../lib/recovery';
import { saveSecret } from '../lib/vault';
import {
  buildIntentTypedData,
  buildPermitTypedData,
  formatPusd,
  formatUsdc,
  generateSecret,
  hashLockForSecret,
  parsePusdAmount,
  quoteRate,
  truncateAddress,
} from '../lib/swap';
import { bchElectrumUrls, bchQuoteConfigError } from '../lib/bch/tip';
import { formatUsdMicros } from '../lib/format';
import { useQuoteAutoRefresh } from '../lib/quote/auto-refresh';
import { assertQuoteStillOpen } from '../lib/quote/expiry';
import { saveQuoteRecord } from '../lib/orders/store';
import { useSolver } from '../lib/solver/context';
import { describeSolverError, type SolverFailure } from '../lib/solver/errors';
import { solverIsLive } from '../lib/solver/kind';
import { useWallets } from '../lib/wallet/context';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BCH_CARRY_SATS,
  BCH_NETWORK,
  BCH_MAX_FEE_SATS,
  FERRY_HTLC_ADDRESS,
  FIXED_FEE_USD_MICROS,
  FWD_BCH_REFUND_BLOCKS,
  FWD_EVM_DEADLINE_S,
  PUSD_CATEGORY,
  PUSD_SYMBOL,
  MAX_QUOTE_FUTURE_S,
  requireSolverSigner,
  SOLVER_BCH_ADDRESS,
  SOLVER_COUNTER_ADDRESS,
  SPREAD_BPS,
  USDC_ADDRESS,
  USDC_DECIMALS,
} from '../lib/config';
import { useToast } from '../lib/toast';
import { LinkVerificationBadge } from '../components/LinkVerificationBadge';
import { ShieldIcon, WalletIcon } from '../components/icons';

export function PayLinkPage() {
  const { linkId } = useParams<{ linkId: string }>();
  const navigate = useNavigate();
  const { evm, usingMocks } = useWallets();
  const solver = useSolver();
  const toast = useToast();
  const [link, setLink] = useState<PayLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [amount, setAmount] = useState('10.00');
  const [quote, setQuote] = useState<SignedQuote | null>(null);
  const [recovery, setRecovery] = useState<RecoveryFile | null>(null);
  const [recoveryDownloaded, setRecoveryDownloaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SolverFailure | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const lockStarted = useRef(false);
  const requestVersion = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!linkId) {
      setLoading(false);
      setLoadError('No pay link id in the URL.');
      return;
    }
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const next = await solver.getPayLink(linkId as string);
        if (!cancelled) {
          setLink(next);
          setLoadError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setLoadError(
            cause instanceof Error ? cause.message : 'Could not load the link',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [linkId, solver]);

  const expired = quote ? isQuoteExpired(quote.terms, now) : false;
  const linkExpired =
    link?.status === 'expired' ||
    (link?.expiresAt !== undefined && link.expiresAt <= now);
  const closed =
    link?.status === 'paid' ||
    link?.status === 'cancelled' ||
    link?.status === 'reserved' ||
    linkExpired;
  const amountOut = link?.kind === 'invoice' ? (link.amountOut ?? 0n) : null;
  const quoteAmountOut = quote ? quote.terms.bchTokenAmount : amountOut;
  const quoteConfigError = bchQuoteConfigError(BCH_NETWORK, bchElectrumUrls());
  const canQuote = Boolean(
    link &&
    link.status === 'open' &&
    !linkExpired &&
    evm.address &&
    !busy &&
    !quoteConfigError,
  );

  const quoteRows = useMemo(() => {
    if (!quote) return null;
    return {
      rate: `1 USDC = ${quoteRate(quote.terms)} ${PUSD_SYMBOL}`,
      fee: formatUsdMicros(FIXED_FEE_USD_MICROS),
      arrival:
        quote.lane === 'fast'
          ? 'Fast lane · under a minute'
          : 'Safe lane · ~1 BCH block',
    };
  }, [quote]);

  function showFailure(cause: unknown, fallback: string): void {
    setError(describeSolverError(cause, fallback));
  }

  function showMessage(sentence: string): void {
    setError({ sentence, nextStep: '', code: null, kind: 'local' });
  }

  async function handleQuote(auto = false): Promise<boolean> {
    if (auto && lockStarted.current) return false;
    const version = ++requestVersion.current;
    if (quoteConfigError) {
      showMessage(quoteConfigError);
      return false;
    }
    if (!link || !evm.address) {
      showMessage('Connect a Base wallet first.');
      return false;
    }
    if (!auto && linkExpired) {
      showMessage('This link has expired.');
      return false;
    }
    if (!auto && closed && !quote) {
      showMessage('This invoice is being paid by another payer.');
      return false;
    }
    if (!auto) {
      autoRefresh.reset();
      setBusy(true);
    }
    setError(null);
    try {
      const nextAmountOut =
        link.kind === 'invoice'
          ? (link.amountOut ?? 0n)
          : parsePusdAmount(amount);
      if (nextAmountOut <= 0n) throw new Error('Enter an amount above zero.');
      const secret = generateSecret();
      const hashLock = hashLockForSecret(secret);
      const request: PayLinkQuoteRequest = {
        counterChain: 'base',
        counterSymbol: 'USDC',
        userCounterAddress: evm.address,
        hashLock,
        lane: 'safe',
        ...(link.kind === 'open' ? { amountOut: nextAmountOut } : {}),
      };
      const next = await solver.quotePayLink(link.id, request);
      if (auto && (lockStarted.current || version !== requestVersion.current)) {
        return false;
      }
      const { parseBchAddress } = await import('../lib/bch/address');
      const solverBch = parseBchAddress(SOLVER_BCH_ADDRESS);
      if (!solverBch.ok) throw new Error(solverBch.error);
      const valid = await verifySignedQuote(next, requireSolverSigner());
      if (!valid) {
        throw new Error('The solver signature does not match the signed terms');
      }
      if (next.lane !== request.lane) {
        throw new Error('Quote lane does not match the request');
      }
      const config: TermsCheckConfig = {
        counterChain: 'base',
        counterNetworkId: BASE_SEPOLIA_CHAIN_ID,
        counterSymbol: request.counterSymbol,
        counterAssetAddress: USDC_ADDRESS,
        counterAssetDecimals: USDC_DECIMALS,
        counterHtlc: FERRY_HTLC_ADDRESS,
        bchToken: link.token,
        bchTokenCategory: PUSD_CATEGORY,
        solverCounterAddress: SOLVER_COUNTER_ADDRESS,
        solverBchLockingBytecode: solverBch.value.lockingBytecode,
        bchTipHeight: next.bchTipHeight,
        bchCarrySats: BCH_CARRY_SATS,
        bchMaxFee: BCH_MAX_FEE_SATS,
        pricingPolicy: {
          spreadBps: SPREAD_BPS,
          fixedFeeUsdMicros: FIXED_FEE_USD_MICROS,
        },
        nowSeconds: Math.floor(Date.now() / 1000),
        maxQuoteFutureSeconds: MAX_QUOTE_FUTURE_S,
        maxCounterDeadlineSeconds: FWD_EVM_DEADLINE_S + 300,
        minBchRefundBlocks: FWD_BCH_REFUND_BLOCKS,
        maxBchRefundBlocks: FWD_BCH_REFUND_BLOCKS + 6,
      };
      assertPayLinkQuote(next.terms, link, request, config);
      assertTimingInvariant(next.terms, config);
      if (auto && (lockStarted.current || version !== requestVersion.current)) {
        return false;
      }
      await saveQuoteRecord(next, solverIsLive());
      const file = buildRecoveryFile(
        next.orderId,
        next.terms,
        secret,
        Math.floor(Date.now() / 1_000),
        solverIsLive() ? 'live' : 'mock',
      );
      await saveSecret(next.orderId, secret);
      setQuote(next);
      setRecovery(file);
      setRecoveryDownloaded(false);
      return true;
    } catch (cause) {
      if (!auto) {
        setQuote(null);
        setRecovery(null);
      }
      showFailure(cause, 'Could not get a quote');
      return false;
    } finally {
      if (!auto) setBusy(false);
    }
  }

  const autoRefresh = useQuoteAutoRefresh({
    enabled: Boolean(quote) && !busy && !linkExpired,
    expiresAt: quote?.terms.quoteExpiry ?? null,
    onRefresh: () => handleQuote(true),
  });

  function handleDownload(): void {
    if (!recovery) return;
    downloadRecoveryFile(recovery);
    setRecoveryDownloaded(true);
    toast.push('Recovery file downloaded. Keep it somewhere safe.', 'success');
  }

  async function handlePay(): Promise<void> {
    if (!quote || !recovery || !evm.address) return;
    if (expired) {
      showMessage('This quote expired. Get a fresh quote before paying.');
      return;
    }
    if (!recoveryDownloaded) {
      showMessage('Download the recovery file before paying.');
      return;
    }
    lockStarted.current = true;
    autoRefresh.cancel();
    setBusy(true);
    setError(null);
    try {
      const nonce = await evm.readPermitNonce(evm.address);
      const permitSignature = await evm.signTypedData(
        buildPermitTypedData(quote.terms, evm.address, nonce),
      );
      const intentSignature = await evm.signTypedData(
        buildIntentTypedData(quote.terms),
      );
      assertQuoteStillOpen(quote.terms);
      await solver.relayLock({
        orderId: quote.orderId,
        terms: quote.terms,
        userEvmAddress: evm.address,
        permitSignature,
        intentSignature,
        permitDeadline: quote.terms.quoteExpiry,
      });
      navigate(`/swap/${quote.orderId}`);
    } catch (cause) {
      showFailure(cause, 'Payment failed');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
        <p className="text-sm text-text-muted" role="status">
          Loading pay link…
        </p>
      </div>
    );
  }

  if (loadError || !link) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
        <p className="text-[10px] font-semibold tracking-[0.2em] text-lime uppercase">
          Pay link
        </p>
        <h1 className="mt-3 text-2xl font-medium">Link unavailable</h1>
        <p className="mt-3 text-sm text-danger" role="alert">
          {loadError ?? 'Pay link not found'}
        </p>
        <Link
          to="/pay"
          className="mt-6 inline-block text-sm font-semibold text-lime"
        >
          Create a pay link
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pt-12 pb-20 sm:px-6">
      <div className="flex items-center gap-2">
        <p className="text-[10px] font-semibold tracking-[0.2em] text-lime uppercase">
          Pay link
        </p>
        <LinkVerificationBadge verified={link.verified} />
      </div>
      <h1 className="mt-3 text-3xl font-medium tracking-[-0.04em] text-text sm:text-4xl">
        {link.kind === 'invoice'
          ? `Pay ${formatPusd(link.amountOut ?? 0n)} ${PUSD_SYMBOL}`
          : 'Send a tip in tPUSD'}
      </h1>
      <p className="mt-2 text-sm leading-6 text-text-muted">
        {link.memo ??
          'Pay with USDC on Base. The exact tPUSD amount lands in the recipient’s BCH wallet.'}
      </p>

      {link.status === 'reserved' ? (
        <div className="mt-6 rounded-well border border-warn/30 bg-warn/10 p-4 text-sm text-text">
          <p className="font-medium">
            {quote
              ? 'Reserved for your payment.'
              : 'This invoice is being paid.'}
          </p>
          <p className="mt-1 text-text-muted">
            {quote
              ? 'Finish the Base lock before the quote expires.'
              : 'Another payer locked first. New payments are paused; if their lock fails, the link reopens automatically.'}
          </p>
        </div>
      ) : null}
      {link.status === 'paid' ? (
        <div className="mt-6 rounded-well border border-ok/30 bg-ok/10 p-4 text-sm">
          <p className="font-medium">This link is paid.</p>
          <p className="mt-1 text-text-muted">
            The recipient can claim the tPUSD with the swap secret.
          </p>
        </div>
      ) : null}
      {link.status === 'cancelled' ? (
        <div className="mt-6 rounded-well border border-danger/30 bg-danger/10 p-4 text-sm">
          This link was cancelled by the recipient.
        </div>
      ) : null}
      {linkExpired && link.status !== 'paid' ? (
        <div className="mt-6 rounded-well border border-danger/30 bg-danger/10 p-4 text-sm">
          This link has expired. Ask the recipient for a new one.
        </div>
      ) : null}

      <section className="mt-6 rounded-card border border-hairline bg-surface-1 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold tracking-[0.14em] text-text-muted uppercase">
              Recipient
            </p>
            <p className="mt-1 break-all font-mono text-[11px] leading-5 text-text">
              {chunkCashaddr(link.recipientCashaddr)}
            </p>
          </div>
          <span className="shrink-0 rounded-pill bg-surface-2 px-2.5 py-1 text-[10px] text-text-muted ring-1 ring-hairline">
            {link.token}
          </span>
        </div>

        <div className="mt-5 border-t border-hairline pt-5">
          {link.kind === 'open' ? (
            <label className="block text-xs font-medium text-text-muted">
              Amount
              <div className="mt-2 flex items-center gap-2 rounded-well bg-surface-2 px-4 py-3 ring-1 ring-hairline">
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => {
                    requestVersion.current += 1;
                    lockStarted.current = false;
                    autoRefresh.reset();
                    setQuote(null);
                    setRecovery(null);
                    setRecoveryDownloaded(false);
                    setAmount(event.target.value);
                  }}
                  className="min-w-0 flex-1 bg-transparent text-2xl font-medium tabular-nums outline-none"
                />
                <span className="text-sm text-text-muted">{PUSD_SYMBOL}</span>
              </div>
            </label>
          ) : (
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-xs font-medium text-text-muted">
                Invoice amount
              </span>
              <span className="text-2xl font-medium tabular-nums">
                {formatPusd(link.amountOut ?? 0n)} {PUSD_SYMBOL}
              </span>
            </div>
          )}
          {link.kind === 'open' && link.minAmountOut ? (
            <p className="mt-2 text-[11px] text-text-muted">
              Minimum {formatPusd(link.minAmountOut)} {PUSD_SYMBOL}
            </p>
          ) : null}
          {link.expiresAt ? (
            <p className="mt-2 text-[11px] text-text-muted">
              Expires{' '}
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(link.expiresAt * 1000))}
            </p>
          ) : null}
        </div>

        <div className="mt-5 rounded-well bg-surface-2 p-4 ring-1 ring-hairline">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <WalletIcon className="size-4 shrink-0 text-text-muted" />
              <div className="min-w-0">
                <p className="text-xs font-medium">Pay from Base</p>
                <p className="truncate text-[11px] text-text-muted">
                  {evm.status === 'unavailable'
                    ? 'Wallet connect needs a Reown project ID'
                    : evm.address
                      ? `Base Sepolia · ${truncateAddress(evm.address)}`
                      : 'Connect a Base Sepolia wallet'}
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={evm.status === 'unavailable'}
              onClick={() => {
                if (evm.status === 'connected') {
                  void evm.disconnect();
                } else {
                  evm.connect();
                }
              }}
              className="rounded-pill border border-hairline bg-surface-3 px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"
            >
              {evm.status === 'connected' ? 'Disconnect' : 'Connect Base'}
            </button>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-text-muted">
            The payer only needs USDC on Base. You do not need a BCH wallet to
            pay this link.
          </p>
        </div>

        {quote ? (
          <dl className="mt-5 divide-y divide-hairline border-y border-hairline text-xs">
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-text-muted">You pay</dt>
              <dd className="font-medium tabular-nums">
                {formatUsdc(quote.terms.counterAmount)} USDC
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-text-muted">They receive</dt>
              <dd className="font-medium tabular-nums">
                {formatPusd(quoteAmountOut ?? 0n)} {PUSD_SYMBOL}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-text-muted">Rate</dt>
              <dd className="font-medium tabular-nums">{quoteRows?.rate}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-text-muted">Fee</dt>
              <dd className="font-medium tabular-nums">{quoteRows?.fee}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-text-muted">Arrival</dt>
              <dd className="text-right font-medium">{quoteRows?.arrival}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-text-muted">Quote expires</dt>
              <dd className="font-medium tabular-nums">
                {formatDuration(Math.max(0, quote.terms.quoteExpiry - now))}
              </dd>
            </div>
          </dl>
        ) : null}

        {autoRefresh.refreshing ? (
          <p
            role="status"
            className="mt-5 rounded-well border border-hairline bg-surface-2 px-3 py-2 text-[11px] leading-5 text-text-muted"
          >
            Refreshing quote… A new secret and recovery file will be issued.
          </p>
        ) : null}
        {autoRefresh.error ? (
          <p
            role="alert"
            className="mt-4 rounded-well border border-danger/25 bg-danger/5 px-3 py-2 text-[11px] leading-5 text-danger"
          >
            {autoRefresh.error}
          </p>
        ) : null}
        {autoRefresh.stopped &&
        autoRefresh.attempts >= 3 &&
        !autoRefresh.error ? (
          <p className="mt-4 text-[11px] leading-5 text-text-muted">
            Auto-refresh paused after 3 refreshes. Get a fresh quote when you
            are ready.
          </p>
        ) : null}

        {recovery ? (
          <button
            type="button"
            onClick={handleDownload}
            disabled={autoRefresh.refreshing}
            className={`mt-5 w-full rounded-pill border px-4 py-3 text-sm font-semibold ${
              recoveryDownloaded
                ? 'border-ok/40 bg-ok/10 text-ok'
                : 'border-hairline bg-surface-2 text-text'
            }`}
          >
            {recoveryDownloaded
              ? 'Recovery file downloaded'
              : 'Download recovery file first'}
          </button>
        ) : null}

        {quoteConfigError ? (
          <p
            className="mt-4 rounded-well border border-warn/25 bg-warn/5 px-3 py-2 text-[11px] leading-5 text-warn"
            role="alert"
          >
            {quoteConfigError}
          </p>
        ) : null}

        {error ? (
          <div
            className="mt-4 rounded-well border border-danger/25 bg-danger/5 px-3 py-2 text-[11px] leading-5 text-danger"
            role="alert"
          >
            <p>{error.sentence}</p>
            {error.nextStep ? (
              <p className="mt-1 text-text-muted">{error.nextStep}</p>
            ) : null}
            {error.code ? (
              <p className="mt-1 font-mono text-[10px] text-text-muted">
                Code: {error.code}
              </p>
            ) : null}
          </div>
        ) : null}

        {!quote ||
        (expired && autoRefresh.stopped && !autoRefresh.refreshing) ? (
          <button
            type="button"
            disabled={!canQuote && !autoRefresh.stopped}
            onClick={() => void handleQuote(false)}
            className="mt-5 w-full rounded-pill bg-lime px-4 py-3 text-sm font-semibold text-lime-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy
              ? 'Getting quote…'
              : expired
                ? 'Get fresh exact quote'
                : 'Get exact quote'}
          </button>
        ) : (
          <button
            type="button"
            disabled={
              busy || autoRefresh.refreshing || expired || !recoveryDownloaded
            }
            onClick={() => void handlePay()}
            className="mt-5 w-full rounded-pill bg-lime px-4 py-3 text-sm font-semibold text-lime-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy
              ? 'Locking USDC…'
              : autoRefresh.refreshing
                ? 'Refreshing quote…'
                : expired
                  ? 'Quote expired'
                  : `Pay ${formatUsdc(quote.terms.counterAmount)} USDC on Base`}
          </button>
        )}

        {quote ? (
          <Link
            to={`/swap/${quote.orderId}`}
            className="mt-3 block text-center text-xs font-semibold text-lime"
          >
            Open swap status
          </Link>
        ) : null}

        <p className="mt-4 flex items-start gap-2 text-[11px] leading-5 text-text-muted">
          <ShieldIcon className="mt-0.5 size-3.5 shrink-0 text-lime" />
          {closed && !quote
            ? 'This link is not accepting new payments.'
            : `The solver fronts the tPUSD, then claims your USDC with the same secret. ${usingMocks ? 'Mock mode: no real funds move.' : ''}`}
        </p>
      </section>
    </div>
  );
}
