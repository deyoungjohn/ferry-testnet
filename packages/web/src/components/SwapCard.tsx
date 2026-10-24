import type { QuoteRequest, SignedQuote } from '../lib/solver/types';
import {
  assertTermsMatchRequest,
  isQuoteExpired,
  verifySignedQuote,
  type TermsCheckConfig,
} from '../lib/solver/verify';
import { formatDuration } from '../lib/solver/view';
import type { RecoveryFile } from '../lib/recovery';
import { buildRecoveryFile, downloadRecoveryFile } from '../lib/recovery';
import { saveSecret } from '../lib/vault';
import {
  buildIntentTypedData,
  buildPermitTypedData,
  formatPusd,
  generateSecret,
  hashLockForSecret,
  parseUsdcAmount,
  quoteRate,
  truncateAddress,
} from '../lib/swap';
import { PUSD_BCH, USDC_BASE } from '../lib/tokens';
import { useSolver } from '../lib/solver/context';
import { useWallets } from '../lib/wallet/context';
import { parseBchAddress } from '../lib/bch/address';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BCH_CARRY_SATS,
  BCH_MAX_FEE_SATS,
  FERRY_HTLC_ADDRESS,
  FIXED_FEE_USD_MICROS,
  FWD_BCH_REFUND_BLOCKS,
  FWD_EVM_DEADLINE_S,
  PUSD_CATEGORY,
  QUOTE_TTL_S,
  requireSolverSigner,
  SOLVER_COUNTER_ADDRESS,
  SPREAD_BPS,
  USDC_ADDRESS,
  USDC_DECIMALS,
} from '../lib/config';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ArrowUpDownIcon, CheckIcon, ShieldIcon } from './icons';
import { TokenPill } from './TokenPill';
import { Well } from './Well';

type Phase = 'idle' | 'quoting' | 'quoted' | 'locking';

export function SwapCard() {
  const navigate = useNavigate();
  const { evm, bch, usingMocks } = useWallets();
  const solver = useSolver();
  const [amount, setAmount] = useState('10.00');
  const [lane, setLane] = useState<'safe' | 'fast'>('safe');
  const [phase, setPhase] = useState<Phase>('idle');
  const [quote, setQuote] = useState<SignedQuote | null>(null);
  const [recovery, setRecovery] = useState<RecoveryFile | null>(null);
  const [recoveryDownloaded, setRecoveryDownloaded] = useState(false);
  const [signatureValid, setSignatureValid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);

  const expired = quote ? isQuoteExpired(quote.terms, now) : false;
  const fastDisabled = Number(amount) > 25;
  const solverLabel = import.meta.env.VITE_SOLVER_URL
    ? 'Live solver'
    : 'Mock solver';
  const busy = phase === 'quoting' || phase === 'locking';
  const walletsReady = Boolean(evm.address && bch.address);
  const canQuote = walletsReady && !busy;

  const receiveAmount = quote ? formatPusd(quote.terms.bchTokenAmount) : '—';
  const receiveFiat = quote
    ? `≈ $${formatPusd(quote.terms.bchTokenAmount)}`
    : 'A quote will fill this in';

  const quoteRows = useMemo(() => {
    if (!quote) return null;
    return {
      rate: `1 USDC = ${quoteRate(quote.terms)} tPUSD`,
      spread: '0.40%',
      fee: '$0.05',
      arrival:
        quote.lane === 'fast'
          ? 'Fast lane · under a minute'
          : 'Safe lane · ~1 BCH block',
    };
  }, [quote]);

  function resetQuote(): void {
    setQuote(null);
    setRecovery(null);
    setRecoveryDownloaded(false);
    setSignatureValid(false);
    setPhase('idle');
    setError(null);
  }

  async function handleQuote(): Promise<void> {
    if (!evm.address || !bch.address) {
      setError('Connect the BCH wallet first, then the Base wallet.');
      return;
    }

    setPhase('quoting');
    setError(null);
    try {
      const amountIn = parseUsdcAmount(amount);
      const secret = generateSecret();
      const hashLock = hashLockForSecret(secret);
      const nextRequest: QuoteRequest = {
        direction: 'COUNTER_TO_BCH',
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
        counterNetworkId: BASE_SEPOLIA_CHAIN_ID,
        counterSymbol: nextRequest.counterSymbol,
        counterAssetAddress: USDC_ADDRESS,
        counterAssetDecimals: USDC_DECIMALS,
        counterHtlc: FERRY_HTLC_ADDRESS,
        bchToken: nextRequest.bchToken,
        bchTokenCategory: PUSD_CATEGORY,
        solverCounterAddress: SOLVER_COUNTER_ADDRESS,
        bchTipHeight: next.bchTipHeight,
        bchCarrySats: BCH_CARRY_SATS,
        bchMaxFee: BCH_MAX_FEE_SATS,
        pricingPolicy: {
          spreadBps: SPREAD_BPS,
          fixedFeeUsdMicros: FIXED_FEE_USD_MICROS,
        },
        nowSeconds: Math.floor(Date.now() / 1000),
        maxQuoteFutureSeconds: QUOTE_TTL_S * 2,
        maxCounterDeadlineSeconds: FWD_EVM_DEADLINE_S + 300,
        minBchRefundBlocks: FWD_BCH_REFUND_BLOCKS,
        maxBchRefundBlocks: FWD_BCH_REFUND_BLOCKS + 6,
      };
      assertTermsMatchRequest(next.terms, nextRequest, checkConfig);
      const file = buildRecoveryFile(next.orderId, next.terms, secret);
      await saveSecret(next.orderId, secret);
      setQuote(next);
      setRecovery(file);
      setRecoveryDownloaded(false);
      setSignatureValid(true);
      setPhase('quoted');
    } catch (cause) {
      setPhase('idle');
      setError(
        cause instanceof Error ? cause.message : 'Could not get a quote',
      );
    }
  }

  function handleDownload(): void {
    if (!recovery) return;
    downloadRecoveryFile(recovery);
    setRecoveryDownloaded(true);
  }

  async function handleFerry(): Promise<void> {
    if (!quote || !recovery || !evm.address) return;
    if (!signatureValid) {
      setError('The quote signature is not valid.');
      return;
    }
    if (expired) {
      setError('This quote expired. Get a fresh quote before locking.');
      return;
    }
    if (!recoveryDownloaded) {
      setError('Download the recovery file before locking.');
      return;
    }

    setPhase('locking');
    setError(null);
    try {
      const nonce = await evm.readPermitNonce(evm.address);
      const permitSignature = await evm.signTypedData(
        buildPermitTypedData(quote.terms, evm.address, nonce),
      );
      const intentSignature = await evm.signTypedData(
        buildIntentTypedData(quote.terms),
      );
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
      setError(cause instanceof Error ? cause.message : 'Locking failed');
    }
  }

  function handlePaste(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = parseBchAddress(paste);
    if (!parsed.ok) {
      setPasteError(parsed.error);
      return;
    }
    bch.setAddress(parsed.value);
    setPaste('');
    setPasteError(null);
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

      <div
        id="wallet-panel"
        className="mt-4 rounded-well border border-hairline bg-surface-2/60 p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-medium tracking-[0.14em] text-text-muted uppercase">
              BCH wallet first
            </p>
            <p className="mt-0.5 truncate text-xs text-text">
              {bch.address
                ? `${bch.walletName ?? 'BCH wallet'} · ${truncateAddress(bch.address.address, 12, 6)}`
                : 'Connect Selene, Paytaca or paste an address'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (bch.status === 'connected') {
                void bch.disconnect();
              } else {
                bch.connect();
              }
            }}
            className="rounded-pill border border-hairline bg-surface-3 px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-lime/30 hover:text-lime"
          >
            {bch.status === 'connected' ? 'Disconnect BCH' : 'Connect BCH'}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
          <div className="min-w-0">
            <p className="text-[10px] font-medium tracking-[0.14em] text-text-muted uppercase">
              Base wallet
            </p>
            <p className="mt-0.5 truncate text-xs text-text">
              {evm.status === 'unavailable'
                ? 'Wallet connect needs a Reown project ID'
                : evm.address
                  ? `Base Sepolia · ${truncateAddress(evm.address)}`
                  : 'Connect a Base Sepolia wallet'}
            </p>
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
            className="rounded-pill border border-hairline bg-surface-3 px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-lime/30 hover:text-lime disabled:cursor-not-allowed disabled:opacity-40"
          >
            {evm.status === 'connected' ? 'Disconnect Base' : 'Connect Base'}
          </button>
        </div>

        <details className="mt-2 text-[11px] text-text-muted">
          <summary className="cursor-pointer select-none hover:text-text">
            Paste a token-aware BCH address instead
          </summary>
          <form onSubmit={handlePaste} className="mt-2 flex gap-2">
            <input
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              placeholder="bchtest:z…"
              aria-label="BCH token-aware address"
              className="min-w-0 flex-1 rounded-pill border border-hairline bg-surface-1 px-3 py-1.5 font-mono text-[11px] text-text outline-none focus:border-lime/50"
            />
            <button
              type="submit"
              className="rounded-pill bg-surface-3 px-3 py-1.5 text-[11px] font-medium text-text"
            >
              Use
            </button>
          </form>
          {pasteError ? (
            <p role="alert" className="mt-1 text-danger">
              {pasteError}
            </p>
          ) : null}
        </details>
      </div>

      <div className="mt-5">
        <Well
          label="You send"
          amount={amount}
          fiat={`≈ $${amount || '0.00'}`}
          balance={usingMocks ? '20.00 USDC' : '—'}
          selector={<TokenPill token={USDC_BASE} />}
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
            aria-label="Direction is fixed in L5"
            aria-disabled="true"
            title="Reverse direction lands in L5"
            className="grid size-10 place-items-center rounded-full border-4 border-surface-1 bg-surface-3 text-text-muted shadow-pill transition-colors hover:text-lime"
          >
            <ArrowUpDownIcon className="size-4" />
          </button>
        </div>

        <Well
          label="You receive"
          amount={receiveAmount}
          fiat={receiveFiat}
          balance="—"
          selector={<TokenPill token={PUSD_BCH} pinned />}
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
              : '0.40% / $0.05'}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-text-muted">Deadlines</dt>
          <dd className="text-right text-text">
            {quote
              ? `${formatDuration(Math.max(0, quote.terms.counterDeadline - now))} Base · ${FWD_BCH_REFUND_BLOCKS} BCH blocks`
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

      <div className="mt-4 space-y-2">
        {quote ? (
          <button
            type="button"
            onClick={handleDownload}
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

        {!quote || expired ? (
          <button
            type="button"
            onClick={() => {
              if (expired) resetQuote();
              void handleQuote();
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
        ) : (
          <button
            type="button"
            onClick={() => void handleFerry()}
            disabled={
              busy || !signatureValid || !recoveryDownloaded || !walletsReady
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
        <p role="alert" className="mt-3 text-[11px] leading-5 text-danger">
          {error}
        </p>
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
    </section>
  );
}
