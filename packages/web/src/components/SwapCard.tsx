import type { Direction } from '@ferry/core';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { bchElectrumUrls, bchQuoteConfigError } from '../lib/bch/tip';
import {
  BASE_CHAIN_ID,
  BCH_CARRY_SATS,
  BCH_MAX_FEE_SATS,
  BCH_NETWORK,
  FERRY_HTLC_ADDRESS,
  FIXED_FEE_USD_MICROS,
  FWD_BCH_REFUND_BLOCKS,
  FWD_EVM_DEADLINE_S,
  PUSD_CATEGORY,
  PUSD_SYMBOL,
  MAX_QUOTE_FUTURE_S,
  REV_BCH_REFUND_BLOCKS,
  REV_EVM_DEADLINE_S,
  requireSolverSigner,
  SOLVER_BCH_ADDRESS,
  SOLVER_COUNTER_ADDRESS,
  SPREAD_BPS,
  USDC_ADDRESS,
  USDC_DECIMALS,
} from '../lib/config';
import { formatBasisPoints, formatUsdMicros } from '../lib/format';
import { useQuoteAutoRefresh } from '../lib/quote/auto-refresh';
import { assertQuoteStillOpen } from '../lib/quote/expiry';
import {
  buildRecoveryFile,
  downloadRecoveryFile,
  type RecoveryFile,
} from '../lib/recovery';
import { saveQuoteRecord } from '../lib/orders/store';
import { useSolver } from '../lib/solver/context';
import { describeSolverError, type SolverFailure } from '../lib/solver/errors';
import { solverIsLive } from '../lib/solver/kind';
import type { QuoteRequest, SignedQuote } from '../lib/solver/types';
import {
  assertTermsMatchRequest,
  assertTimingInvariant,
  isQuoteExpired,
  verifySignedQuote,
  type TermsCheckConfig,
} from '../lib/solver/verify';
import { formatDuration } from '../lib/solver/view';
import {
  buildIntentTypedData,
  buildPermitTypedData,
  formatPusd,
  formatUsdc,
  describeUsdcShortfall,
  generateSecret,
  hashLockForSecret,
  parsePusdAmount,
  parseUsdcAmount,
  quoteRate,
} from '../lib/swap';
import { useToast } from '../lib/toast';
import { PUSD_BCH, USDC_BASE } from '../lib/tokens';
import { saveSecret } from '../lib/vault';
import { useWallets } from '../lib/wallet/context';
import { ArrowUpDownIcon, CheckIcon, ShieldIcon } from './icons';
import { TokenPill } from './TokenPill';
import { WalletPanel } from './WalletPanel';
import { Well } from './Well';

const ReverseFundingPanel = lazy(async () => {
  const module = await import('./ReverseFundingPanel');
  return { default: module.ReverseFundingPanel };
});

const ReviewDialog = lazy(async () => {
  const module = await import('./ReviewDialog');
  return { default: module.ReviewDialog };
});

type Phase = 'idle' | 'quoting' | 'quoted' | 'locking';

function initialDirection(): Direction {
  if (typeof window === 'undefined') return 'COUNTER_TO_BCH';
  return new URLSearchParams(window.location.search).get('direction') ===
    'reverse'
    ? 'BCH_TO_COUNTER'
    : 'COUNTER_TO_BCH';
}

export function SwapCard() {
  const navigate = useNavigate();
  const { evm, bch, usingMocks } = useWallets();
  const solver = useSolver();
  const [amount, setAmount] = useState('10.00');
  const [direction, setDirection] = useState<Direction>(initialDirection);
  const [lane, setLane] = useState<'safe' | 'fast'>('safe');
  const [phase, setPhase] = useState<Phase>('idle');
  const [quote, setQuote] = useState<SignedQuote | null>(null);
  const [recovery, setRecovery] = useState<RecoveryFile | null>(null);
  const [recoveryDownloaded, setRecoveryDownloaded] = useState(false);
  const [signatureValid, setSignatureValid] = useState(false);
  const [error, setError] = useState<SolverFailure | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [reviewOpen, setReviewOpen] = useState(false);
  const lockStarted = useRef(false);
  const requestVersion = useRef(0);
  const toast = useToast();

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);

  const expired = quote ? isQuoteExpired(quote.terms, now) : false;
  const reverse = direction === 'BCH_TO_COUNTER';
  const fastDisabled = Number(amount) > 25;
  const solverLabel = solverIsLive() ? 'Live solver' : 'Mock solver';
  const busy = phase === 'quoting' || phase === 'locking';
  const walletsReady = Boolean(evm.address && bch.address);
  const quoteConfigError = bchQuoteConfigError(BCH_NETWORK, bchElectrumUrls());
  const canQuote = walletsReady && !busy && !quoteConfigError;

  const receiveAmount = quote
    ? reverse
      ? formatUsdc(quote.terms.counterAmount)
      : formatPusd(quote.terms.bchTokenAmount)
    : '—';
  const receiveFiat = quote
    ? `≈ $${reverse ? formatUsdc(quote.terms.counterAmount) : formatPusd(quote.terms.bchTokenAmount)}`
    : 'A quote will fill this in';

  const quoteRows = useMemo(() => {
    if (!quote) return null;
    return {
      rate: reverse
        ? `1 ${PUSD_SYMBOL} = ${quoteRate(quote.terms)} USDC`
        : `1 USDC = ${quoteRate(quote.terms)} ${PUSD_SYMBOL}`,
      spread: formatBasisPoints(SPREAD_BPS),
      fee: formatUsdMicros(FIXED_FEE_USD_MICROS),
      arrival:
        quote.lane === 'fast'
          ? 'Fast lane · under a minute'
          : 'Safe lane · ~1 BCH block',
    };
  }, [quote, reverse]);

  function resetQuote(): void {
    requestVersion.current += 1;
    lockStarted.current = false;
    autoRefresh.reset();
    setQuote(null);
    setRecovery(null);
    setRecoveryDownloaded(false);
    setSignatureValid(false);
    setPhase('idle');
    setError(null);
  }

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
    if (!evm.address || !bch.address) {
      showMessage('Connect the BCH wallet first, then the Base wallet.');
      return false;
    }

    if (!auto) {
      autoRefresh.reset();
      setPhase('quoting');
    }
    setError(null);
    try {
      const amountIn = reverse
        ? parsePusdAmount(amount)
        : parseUsdcAmount(amount);
      const secret = generateSecret();
      const hashLock = hashLockForSecret(secret);
      const nextRequest: QuoteRequest = {
        direction,
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn,
        userCounterAddress: evm.address,
        userBchLockingBytecode: bch.address.lockingBytecode,
        hashLock,
        lane,
        ...(lane === 'fast' ? { fastOptIn: true } : {}),
      };
      const next = await solver.quote(nextRequest);
      if (auto && (lockStarted.current || version !== requestVersion.current)) {
        return false;
      }
      const { parseBchAddress } = await import('../lib/bch/address');
      const solverBch = parseBchAddress(SOLVER_BCH_ADDRESS);
      if (!solverBch.ok) throw new Error(solverBch.error);
      const signer = requireSolverSigner();
      const valid = await verifySignedQuote(next, signer);
      if (!valid) {
        throw new Error('The solver signature does not match the signed terms');
      }
      if (next.lane !== nextRequest.lane) {
        throw new Error('Quote lane does not match the request');
      }
      const checkConfig: TermsCheckConfig = {
        counterChain: 'base',
        counterNetworkId: BASE_CHAIN_ID,
        counterSymbol: nextRequest.counterSymbol,
        counterAssetAddress: USDC_ADDRESS,
        counterAssetDecimals: USDC_DECIMALS,
        counterHtlc: FERRY_HTLC_ADDRESS,
        bchToken: nextRequest.bchToken,
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
        maxCounterDeadlineSeconds:
          (reverse ? REV_EVM_DEADLINE_S : FWD_EVM_DEADLINE_S) + 300,
        minBchRefundBlocks: reverse
          ? REV_BCH_REFUND_BLOCKS
          : FWD_BCH_REFUND_BLOCKS,
        maxBchRefundBlocks:
          (reverse ? REV_BCH_REFUND_BLOCKS : FWD_BCH_REFUND_BLOCKS) + 6,
      };
      assertTermsMatchRequest(next.terms, nextRequest, checkConfig);
      assertTimingInvariant(next.terms, checkConfig);
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
      setSignatureValid(true);
      setPhase('quoted');
      return true;
    } catch (cause) {
      if (!auto) setPhase('idle');
      showFailure(cause, 'Could not get a quote');
      return false;
    }
  }

  const autoRefresh = useQuoteAutoRefresh({
    enabled: phase === 'quoted' && Boolean(quote) && !busy,
    expiresAt: quote?.terms.quoteExpiry ?? null,
    onRefresh: () => handleQuote(true),
  });

  function handleDirection(): void {
    resetQuote();
    setDirection((current) =>
      current === 'COUNTER_TO_BCH' ? 'BCH_TO_COUNTER' : 'COUNTER_TO_BCH',
    );
    setAmount('10.00');
  }

  function handleFunded(txid: string): void {
    if (!quote) return;
    lockStarted.current = true;
    autoRefresh.cancel();
    navigate(`/swap/${quote.orderId}`, {
      state: { fundingTxid: txid },
    });
  }

  function handleDownload(): void {
    if (!recovery) return;
    downloadRecoveryFile(recovery);
    setRecoveryDownloaded(true);
    toast.push('Recovery file downloaded. Keep it somewhere safe.', 'success');
  }

  function handleTokenSelect(next: { readonly symbol: string }): void {
    const nextIsPusd = next.symbol === PUSD_SYMBOL;
    if (nextIsPusd !== reverse) handleDirection();
  }

  async function handleFerry(): Promise<void> {
    if (reverse) {
      showMessage('Use the BCH funding panel for a reverse swap.');
      return;
    }
    if (!quote || !recovery || !evm.address) return;
    if (!signatureValid) {
      showMessage('The quote signature is not valid.');
      return;
    }
    if (expired) {
      showMessage('This quote expired. Get a fresh quote before locking.');
      return;
    }
    if (!recoveryDownloaded) {
      showMessage('Download the recovery file before locking.');
      return;
    }

    lockStarted.current = true;
    autoRefresh.cancel();
    setPhase('locking');
    setError(null);
    try {
      const shortfall = describeUsdcShortfall(
        await evm.readTokenBalance(evm.address),
        quote.terms.counterAmount,
      );
      if (shortfall) {
        setPhase('quoted');
        showMessage(shortfall);
        return;
      }
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
      setPhase('quoted');
      showFailure(cause, 'Locking failed');
    }
  }

  return (
    <section
      id="swap"
      aria-labelledby="swap-title"
      className="card-ring relative w-full max-w-[30rem] rounded-card border border-hairline bg-surface-1 p-5 sm:p-6"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 id="swap-title" className="text-sm font-semibold tracking-tight">
            Swap
          </h2>
          <span className="rounded-pill bg-olive-soft px-2 py-0.5 text-[9px] font-medium tracking-[0.14em] text-lime uppercase ring-1 ring-lime/15">
            {solverLabel}
          </span>
        </div>
        <div
          role="group"
          aria-label="Lane"
          className="flex shrink-0 items-center gap-0.5 rounded-pill bg-surface-2 p-0.5 text-[10px] ring-1 ring-hairline"
        >
          <button
            type="button"
            aria-pressed={lane === 'fast'}
            disabled={fastDisabled}
            title={
              fastDisabled
                ? 'Fast lane is limited to swaps under $25'
                : 'Fast lane uses 0-conf BCH'
            }
            onClick={() => {
              resetQuote();
              setLane('fast');
            }}
            className="rounded-pill px-2 py-1 text-text-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-surface-3 aria-pressed:font-medium aria-pressed:text-text aria-pressed:ring-1 aria-pressed:ring-hairline"
          >
            Fast ≤ $25
          </button>
          <button
            type="button"
            aria-pressed={lane === 'safe'}
            onClick={() => {
              resetQuote();
              setLane('safe');
            }}
            className="rounded-pill px-2 py-1 text-text-muted aria-pressed:bg-surface-3 aria-pressed:font-medium aria-pressed:text-text aria-pressed:ring-1 aria-pressed:ring-hairline"
          >
            Safe
          </button>
        </div>
      </div>

      <div className="mt-4">
        <WalletPanel />
      </div>

      <div className="mt-5">
        <Well
          label="You send"
          amount={amount}
          fiat={`≈ $${amount || '0.00'}`}
          balance={
            usingMocks ? (reverse ? `50.00 ${PUSD_SYMBOL}` : '20.00 USDC') : '—'
          }
          selector={
            <TokenPill
              token={reverse ? PUSD_BCH : USDC_BASE}
              pinned={reverse}
              onSelect={handleTokenSelect}
            />
          }
          editable
          disabled={busy}
          onAmountChange={(value) => {
            resetQuote();
            setAmount(value);
          }}
        />

        <div className="relative z-10 -my-2.5 flex justify-center">
          <button
            type="button"
            aria-label="Switch swap direction"
            aria-pressed={reverse}
            title={
              reverse
                ? 'Switch to USDC on Base → tPUSD on BCH'
                : 'Switch to tPUSD on BCH → USDC on Base'
            }
            onClick={handleDirection}
            className="grid size-10 place-items-center rounded-full border-4 border-surface-1 bg-surface-3 text-text-muted shadow-pill transition-colors hover:text-lime aria-pressed:bg-olive-soft aria-pressed:text-lime"
          >
            <ArrowUpDownIcon className="size-4" />
          </button>
        </div>

        <Well
          label="You receive"
          amount={receiveAmount}
          fiat={receiveFiat}
          balance="—"
          selector={
            <TokenPill
              token={reverse ? USDC_BASE : PUSD_BCH}
              pinned={!reverse}
            />
          }
        />
      </div>

      <dl className="mt-5 divide-y divide-hairline border-y border-hairline text-xs">
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-text-muted">Rate</dt>
          <dd className="text-right font-medium tabular-nums text-text">
            {quoteRows?.rate ?? 'Get a quote'}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-text-muted">Spread / fixed fee</dt>
          <dd className="font-medium tabular-nums text-text">
            {quoteRows
              ? `${quoteRows.spread} / ${quoteRows.fee}`
              : `${formatBasisPoints(SPREAD_BPS)} / ${formatUsdMicros(FIXED_FEE_USD_MICROS)}`}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-text-muted">Deadlines</dt>
          <dd className="text-right text-text">
            {quote
              ? `${formatDuration(Math.max(0, quote.terms.counterDeadline - now))} Base · ${reverse ? REV_BCH_REFUND_BLOCKS : FWD_BCH_REFUND_BLOCKS} BCH blocks`
              : reverse
                ? 'Base 6h · BCH 144 blocks'
                : 'Base 24h · BCH 36 blocks'}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-text-muted">Arrival</dt>
          <dd className="text-right text-text">
            {quoteRows?.arrival ?? 'Safe lane · ~1 BCH block'}
          </dd>
        </div>
      </dl>

      {lane === 'fast' ? (
        <p
          role="note"
          className="mt-3 rounded-well border border-warn/25 bg-warn/5 px-3 py-2 text-[11px] leading-5 text-warn"
        >
          Fast lane is opt-in: it relies on a 0-conf BCH lock and a DSProof
          window. You accept the small reorg risk in exchange for speed.
        </p>
      ) : null}

      {quoteConfigError ? (
        <p
          role="alert"
          className="mt-3 rounded-well border border-warn/25 bg-warn/5 px-3 py-2 text-[11px] leading-5 text-warn"
        >
          {quoteConfigError}
        </p>
      ) : null}

      {autoRefresh.refreshing ? (
        <p
          role="status"
          className="mt-3 rounded-well border border-hairline bg-surface-2 px-3 py-2 text-[11px] leading-5 text-text-muted"
        >
          Refreshing quote… A new secret and recovery file will be issued.
        </p>
      ) : null}
      {autoRefresh.error ? (
        <p
          role="alert"
          className="mt-3 rounded-well border border-danger/25 bg-danger/5 px-3 py-2 text-[11px] leading-5 text-danger"
        >
          {autoRefresh.error}
        </p>
      ) : null}
      {autoRefresh.stopped &&
      autoRefresh.attempts >= 3 &&
      !autoRefresh.error ? (
        <p className="mt-3 text-[11px] leading-5 text-text-muted">
          Auto-refresh paused after 3 refreshes. Get a new quote when you are
          ready.
        </p>
      ) : null}

      <div className="mt-4 space-y-2">
        {quote ? (
          <button
            type="button"
            onClick={handleDownload}
            disabled={autoRefresh.refreshing}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-pill border border-hairline bg-surface-2 text-sm font-medium text-text transition-colors hover:border-lime/30 hover:text-lime"
          >
            {recoveryDownloaded ? (
              <>
                <CheckIcon className="size-4 text-ok" />
                Recovery file downloaded
              </>
            ) : (
              'Download recovery file'
            )}
          </button>
        ) : null}

        {quote && !reverse ? (
          <button
            type="button"
            onClick={() => setReviewOpen(true)}
            disabled={autoRefresh.refreshing}
            className="flex h-11 w-full items-center justify-center rounded-pill border border-hairline bg-surface-2 text-sm font-medium text-text transition-colors hover:border-lime/30 hover:text-lime"
          >
            Review and confirm
          </button>
        ) : null}

        {(!quote || expired) && !autoRefresh.refreshing ? (
          <button
            type="button"
            onClick={() => {
              if (expired) resetQuote();
              void handleQuote(false);
            }}
            disabled={!canQuote}
            className="flex h-13 w-full items-center justify-center gap-1.5 rounded-pill bg-olive px-5 text-sm font-semibold text-text shadow-pill transition-[filter,transform] hover:brightness-110 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
          >
            {phase === 'quoting'
              ? 'Getting a signed quote…'
              : expired
                ? 'Quote expired — get a fresh quote'
                : 'Get quote'}
          </button>
        ) : reverse && quote ? (
          <Suspense
            fallback={
              <p
                className="text-center text-[11px] text-text-muted"
                role="status"
              >
                Loading the BCH funding panel…
              </p>
            }
          >
            <ReverseFundingPanel
              terms={quote.terms}
              onFunded={handleFunded}
              onFundingStart={() => {
                lockStarted.current = true;
                autoRefresh.cancel();
              }}
              disabled={
                autoRefresh.refreshing ||
                !recoveryDownloaded ||
                !signatureValid ||
                !walletsReady
              }
              disabledReason={
                autoRefresh.refreshing
                  ? 'Wait for the refreshed quote before funding.'
                  : !recoveryDownloaded
                    ? 'Download the recovery file before funding the BCH lock.'
                    : !signatureValid
                      ? 'The solver signature is not valid.'
                      : 'Connect both wallets before funding.'
              }
            />
          </Suspense>
        ) : (
          <button
            type="button"
            onClick={() => void handleFerry()}
            disabled={
              busy ||
              autoRefresh.refreshing ||
              !signatureValid ||
              !recoveryDownloaded ||
              !walletsReady
            }
            title={
              !recoveryDownloaded
                ? 'Download the recovery file first'
                : !signatureValid
                  ? 'The solver signature is not valid'
                  : undefined
            }
            className="flex h-13 w-full items-center justify-center gap-1.5 rounded-pill bg-olive px-5 text-sm font-semibold text-text shadow-pill transition-[filter,transform] hover:brightness-110 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
          >
            {phase === 'locking' ? 'Signing and relaying…' : 'Ferry it'}
            <span aria-hidden="true" className="text-base leading-none">
              ›
            </span>
          </button>
        )}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-well border border-danger/25 bg-danger/5 px-3 py-2 text-[11px] leading-5 text-danger"
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

      {quote ? (
        <p className="mt-3 text-[11px] leading-5 text-text-muted">
          Quote {quote.orderId.slice(0, 10)}… expires in{' '}
          {formatDuration(Math.max(0, quote.terms.quoteExpiry - now))}. The
          solver signature covers every term, including the BCH address and the
          Base HTLC.
        </p>
      ) : null}

      <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-text-muted">
        <ShieldIcon className="size-3.5 text-ok" />
        Refunds are automatic if the swap stalls. BCH carry{' '}
        {BCH_CARRY_SATS.toString()} sats.
      </p>

      {quote && !reverse && reviewOpen ? (
        <Suspense fallback={null}>
          <ReviewDialog
            open
            onOpenChange={setReviewOpen}
            quote={quote}
            recovery={recovery}
            recoveryDownloaded={recoveryDownloaded}
            expired={expired}
            busy={busy}
            reverse={reverse}
            now={now}
            onDownload={handleDownload}
            onConfirm={() => void handleFerry()}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
