import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { BchAddressInfo } from '../lib/bch/address';
import { BCH_EXPLORER_URL } from '../lib/config';
import { chunkCashaddr } from '../lib/paylink/link';
import {
  buildSpikeTokenLock,
  connectPaytaca,
  detectProvider,
  inspectSignedSpikeLock,
  readSpikeFunding,
  signSpikeLock,
  waitForProvider,
  type PaytacaProvider,
  type SignedSpikeLock,
  type SpikeFunding,
  type SpikeTokenLock,
} from '../lib/wallet/extension-spike';

type Busy = 'connect' | 'build' | 'sign' | null;

interface SignedResult {
  readonly summary: SignedSpikeLock;
  readonly providerHash: string | null;
  readonly hashMatches: boolean | null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function shorten(value: string, start = 12, end = 8): string {
  if (value.length <= start + end + 1) return value;
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

export function WalletExtensionSpikePage() {
  const [detecting, setDetecting] = useState(true);
  const [provider, setProvider] = useState<PaytacaProvider | null>(null);
  const [hasSeleneGlobal, setHasSeleneGlobal] = useState(false);
  const [address, setAddress] = useState<BchAddressInfo | null>(null);
  const [funding, setFunding] = useState<SpikeFunding | null>(null);
  const [lock, setLock] = useState<SpikeTokenLock | null>(null);
  const [signed, setSigned] = useState<SignedResult | null>(null);
  const [readingFunding, setReadingFunding] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void waitForProvider().then((detection) => {
      if (!active) return;
      setProvider(detection.paytaca);
      setHasSeleneGlobal(detection.hasSeleneGlobal);
      setDetecting(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!address) return;
    let active = true;
    setReadingFunding(true);
    setFunding(null);
    setLock(null);
    setSigned(null);
    setError(null);
    void readSpikeFunding(address)
      .then((next) => {
        if (active) setFunding(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setReadingFunding(false);
      });
    return () => {
      active = false;
    };
  }, [address]);

  function rescan(): void {
    const detection = detectProvider();
    setProvider(detection.paytaca);
    setHasSeleneGlobal(detection.hasSeleneGlobal);
    setDetecting(false);
  }

  async function handleConnect(): Promise<void> {
    if (!provider) return;
    setBusy('connect');
    setError(null);
    setSigned(null);
    try {
      setAddress(await connectPaytaca(provider));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  function handleBuild(): void {
    if (!address || !funding) return;
    setBusy('build');
    setError(null);
    setSigned(null);
    try {
      setLock(buildSpikeTokenLock({ address, funding }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function handleSign(): Promise<void> {
    if (!provider || !lock) return;
    setBusy('sign');
    setError(null);
    try {
      const response = await signSpikeLock(provider, lock);
      if (!response?.signedTransaction) {
        throw new Error(
          'The wallet rejected the request or returned no signature',
        );
      }
      const summary = inspectSignedSpikeLock(response.signedTransaction, lock);
      const providerHash =
        response.signedTransactionHash?.toLowerCase().replace(/^0x/, '') ??
        null;
      setSigned({
        summary,
        providerHash,
        hashMatches: providerHash ? providerHash === summary.txid : null,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const tokenUtxos =
    funding?.utxos.filter(
      (utxo) => utxo.category !== null && utxo.amount !== null,
    ) ?? [];

  return (
    <div
      className="mx-auto w-full max-w-4xl px-4 pt-12 pb-20 sm:px-6"
      data-spike-marker="FERRY_WALLET_EXTENSION_SPIKE_MARKER"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[10px] font-semibold tracking-[0.2em] text-lime uppercase">
          Dev only · chipnet
        </p>
        <span className="rounded-pill border border-warn/40 bg-warn/10 px-2 py-0.5 text-[10px] font-semibold text-warn">
          No broadcast
        </span>
      </div>
      <h1 className="mt-3 max-w-2xl text-3xl font-medium tracking-[-0.04em] text-text sm:text-4xl">
        Wallet-extension probe.
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-text-muted">
        Connect an injected BCH provider, read its chipnet address, build a
        fixed P2SH32 CashTokens lock, and ask the wallet to sign it. The
        transaction is never broadcast and no production swap path uses this
        page.
      </p>

      <section className="mt-8 rounded-card border border-hairline bg-surface-1 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">1. Detected providers</h2>
            <p className="mt-1 text-xs text-text-muted">
              {detecting
                ? 'Looking for a legacy Paytaca injected provider…'
                : provider
                  ? 'Paytaca connector found on window.paytaca.'
                  : 'No window.paytaca provider found.'}
            </p>
          </div>
          <button
            type="button"
            onClick={rescan}
            className="rounded-pill bg-surface-3 px-3 py-2 text-[11px] font-semibold text-text ring-1 ring-hairline"
          >
            Rescan
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-well bg-surface-2 p-4 ring-1 ring-hairline">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold">Paytaca</p>
              <span
                className={`rounded-pill px-2 py-0.5 text-[10px] font-semibold ${
                  provider
                    ? 'bg-olive-soft text-lime'
                    : 'bg-surface-3 text-text-muted'
                }`}
              >
                {provider ? 'provider found' : 'not found'}
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-text-muted">
              Detected only through the legacy community connector API
              (`connect`, `address`, `signTransaction`). Current official source
              v0.27.4 is an extension app and does not ship that page-injected
              provider.
            </p>
          </div>
          <div className="rounded-well bg-surface-2 p-4 ring-1 ring-hairline">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold">Selene</p>
              <span className="rounded-pill bg-surface-3 px-2 py-0.5 text-[10px] font-semibold text-text-muted">
                no extension API
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-text-muted">
              Selene ships as a native app and a browser PWA. No browser
              extension or injected provider API appears in its official
              repository or download page.
              {hasSeleneGlobal
                ? ' An undocumented window.selene global is present; this probe does not call it.'
                : ''}
            </p>
          </div>
        </div>

        <p className="mt-4 text-[11px] leading-5 text-text-muted">
          Evidence:{' '}
          <a
            className="text-lime underline decoration-lime/30 underline-offset-2"
            href="https://github.com/paytaca/paytaca-app"
            target="_blank"
            rel="noreferrer"
          >
            Paytaca source
          </a>
          {' · '}
          <a
            className="text-lime underline decoration-lime/30 underline-offset-2"
            href="https://selene.cash/download"
            target="_blank"
            rel="noreferrer"
          >
            Selene downloads
          </a>
          {' · '}
          <a
            className="text-lime underline decoration-lime/30 underline-offset-2"
            href="https://github.com/mainnet-pat/wc2-bch-bcr"
            target="_blank"
            rel="noreferrer"
          >
            legacy connector interface
          </a>
        </p>

        {provider ? (
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={busy !== null}
            className="mt-5 w-full rounded-pill bg-lime px-4 py-3 text-sm font-semibold text-lime-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'connect'
              ? 'Waiting for the wallet…'
              : address
                ? 'Reconnect wallet'
                : 'Connect Paytaca'}
          </button>
        ) : null}
      </section>

      {address ? (
        <section className="mt-5 rounded-card border border-hairline bg-surface-1 p-5 sm:p-6">
          <h2 className="text-sm font-semibold">2. Chipnet address</h2>
          <p className="mt-3 break-all font-mono text-[11px] leading-5 text-text">
            {chunkCashaddr(address.address)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-muted">
            <span className="rounded-pill bg-surface-2 px-2 py-1 ring-1 ring-hairline">
              P2PKH token-aware
            </span>
            <span className="rounded-pill bg-surface-2 px-2 py-1 ring-1 ring-hairline">
              {shorten(address.lockingBytecode)}
            </span>
          </div>

          <div className="mt-5 border-t border-hairline pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold">Chipnet funding</h3>
              <span className="text-[11px] text-text-muted">
                {readingFunding
                  ? 'Reading Electrum…'
                  : funding
                    ? `Tip ${funding.tipHeight.toLocaleString()}`
                    : 'Unavailable'}
              </span>
            </div>
            {funding ? (
              <p className="mt-2 text-xs text-text-muted">
                {tokenUtxos.length === 0
                  ? 'No CashToken UTXOs at this address. Send one small chipnet token before testing the token lock.'
                  : `${tokenUtxos.length} CashToken UTXO${tokenUtxos.length === 1 ? '' : 's'} found. The probe will lock 1 base unit.`}
              </p>
            ) : null}
            <button
              type="button"
              onClick={handleBuild}
              disabled={
                busy !== null ||
                readingFunding ||
                !funding ||
                tokenUtxos.length === 0
              }
              className="mt-4 w-full rounded-pill bg-text px-4 py-3 text-sm font-semibold text-bg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'build' ? 'Building…' : 'Build P2SH32 token lock'}
            </button>
          </div>
        </section>
      ) : null}

      {lock ? (
        <section className="mt-5 rounded-card border border-lime/25 bg-surface-1 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">3. Fixed test lock</h2>
            <span className="rounded-pill bg-olive-soft px-2 py-0.5 text-[10px] font-semibold text-lime">
              not broadcast
            </span>
          </div>
          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-text-muted">P2SH32 token address</dt>
              <dd className="mt-1 break-all font-mono text-[11px] text-text">
                {lock.tokenAddress}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Token</dt>
              <dd className="mt-1 break-all font-mono text-[11px] text-text">
                {lock.tokenAmount.toString()} · {shorten(lock.tokenCategory)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Unsigned txid</dt>
              <dd className="mt-1 break-all font-mono text-[11px] text-text">
                {shorten(lock.txid, 16, 12)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Fee</dt>
              <dd className="mt-1 font-mono text-[11px] text-text">
                {lock.feeSats.toString()} sats
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-[11px] leading-5 text-text-muted">
            The output pays the P2SH32 HTLC locking bytecode with a token. The
            wallet is asked to sign with broadcast disabled.
          </p>
          <a
            className="mt-3 inline-block text-[11px] text-lime underline decoration-lime/30 underline-offset-2"
            href={`${BCH_EXPLORER_URL}/address/${lock.p2sh32Address}`}
            target="_blank"
            rel="noreferrer"
          >
            View P2SH32 address on the chipnet explorer
          </a>
          <details className="mt-4 rounded-well bg-surface-2 p-3">
            <summary className="cursor-pointer text-[11px] font-semibold text-text-muted">
              Unsigned transaction hex
            </summary>
            <p className="mt-2 break-all font-mono text-[10px] leading-5 text-text-muted">
              {lock.txHex}
            </p>
          </details>
          <button
            type="button"
            onClick={() => void handleSign()}
            disabled={busy !== null}
            className="mt-5 w-full rounded-pill bg-lime px-4 py-3 text-sm font-semibold text-lime-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'sign' ? 'Waiting for the wallet…' : 'Sign in Paytaca'}
          </button>
        </section>
      ) : null}

      {signed ? (
        <section className="mt-5 rounded-card border border-ok/30 bg-surface-1 p-5 sm:p-6">
          <h2 className="text-sm font-semibold">4. Signature returned</h2>
          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-text-muted">Signed inputs</dt>
              <dd className="mt-1 font-mono text-[11px] text-text">
                {signed.summary.signedInputs}/{signed.summary.inputCount}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Computed txid</dt>
              <dd className="mt-1 break-all font-mono text-[11px] text-text">
                {shorten(signed.summary.txid, 16, 12)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Token output</dt>
              <dd className="mt-1 break-all font-mono text-[11px] text-text">
                {signed.summary.tokenAmount.toString()} ·{' '}
                {shorten(signed.summary.tokenCategory)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Wallet-reported txid</dt>
              <dd className="mt-1 break-all font-mono text-[11px] text-text">
                {signed.providerHash
                  ? `${shorten(signed.providerHash, 16, 12)} · ${
                      signed.hashMatches ? 'matches' : 'MISMATCH'
                    }`
                  : 'not returned'}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-[11px] leading-5 text-text-muted">
            The returned transaction has non-empty unlocking bytecode for every
            input and still pays the expected P2SH32 token output. Ferry did not
            validate the signature cryptographically and did not broadcast
            anything.
          </p>
        </section>
      ) : null}

      {error ? (
        <p
          className="mt-5 rounded-well border border-danger/30 bg-danger/10 p-4 text-sm text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <Link
        to="/"
        className="mt-8 inline-block text-sm text-text-muted transition-colors hover:text-lime"
      >
        ← Back to the swap
      </Link>
    </div>
  );
}
