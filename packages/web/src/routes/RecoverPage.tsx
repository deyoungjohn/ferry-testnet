import { useState } from 'react';
import { Link } from 'react-router';
import {
  broadcastBchClaim,
  broadcastBchRefund,
  evmRefundCalldata,
  loadRecoverySnapshot,
  parseRecoveryJson,
  sendEvmRefund,
  validateRecoveryFile,
  type Eip1193Provider,
  type ElectrumUtxo,
  type RecoveryEndpoints,
  type RecoverySnapshot,
} from '../recover/core';
import type { RecoveryFile } from '../lib/recovery';
import { formatPusd, formatUsdc, truncateAddress } from '../lib/swap';

const CHIPNET_ELECTRUM = 'wss://chipnet.imaginary.cash:50004';
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';

type Notice = { readonly kind: 'info' | 'ok' | 'error'; readonly text: string };

function noticeClass(kind: Notice['kind']): string {
  if (kind === 'error') {
    return 'border-danger/25 bg-danger/5 text-danger';
  }
  if (kind === 'ok') {
    return 'border-ok/25 bg-ok/5 text-ok';
  }
  return 'border-hairline bg-surface-2 text-text-muted';
}

export function RecoverPage() {
  const [recovery, setRecovery] = useState<RecoveryFile | null>(null);
  const [snapshot, setSnapshot] = useState<RecoverySnapshot | null>(null);
  const [endpoints, setEndpoints] = useState<RecoveryEndpoints>({
    electrumUrl: CHIPNET_ELECTRUM,
    baseRpcUrl: BASE_SEPOLIA_RPC,
  });
  const [fileNotice, setFileNotice] = useState<Notice | null>(null);
  const [chainNotice, setChainNotice] = useState<Notice | null>(null);
  const [actionNotice, setActionNotice] = useState<Notice | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setFileNotice({ kind: 'info', text: 'Reading the recovery file…' });
    setSnapshot(null);
    setActionNotice(null);
    try {
      const text = await file.text();
      const parsed = validateRecoveryFile(parseRecoveryJson(text));
      setRecovery(parsed);
      setFileNotice({
        kind: 'ok',
        text:
          parsed.solverKind === 'mock'
            ? 'Recovery file loaded. This file was issued by the mock solver and cannot be claimed on chain.'
            : 'Recovery file loaded. The BCH address was recomputed and matches.',
      });
    } catch (cause) {
      setRecovery(null);
      setFileNotice({
        kind: 'error',
        text:
          cause instanceof Error
            ? cause.message
            : 'Could not read that recovery file',
      });
    }
  }

  async function checkChains(): Promise<void> {
    if (!recovery) return;
    setChecking(true);
    setChainNotice({ kind: 'info', text: 'Reading both chains…' });
    try {
      const next = await loadRecoverySnapshot(recovery, endpoints);
      setSnapshot(next);
      if (next.bch.ok && next.evm.ok) {
        setChainNotice({
          kind: 'ok',
          text: `BCH tip ${next.bch.tipHeight}; Base block ${next.evm.blockTimestamp}.`,
        });
      } else {
        setChainNotice({
          kind: 'error',
          text: [
            !next.bch.ok ? `BCH: ${next.bch.error}` : '',
            !next.evm.ok ? `Base: ${next.evm.error}` : '',
          ]
            .filter(Boolean)
            .join(' '),
        });
      }
    } catch (cause) {
      setChainNotice({
        kind: 'error',
        text: cause instanceof Error ? cause.message : 'Could not check chains',
      });
    } finally {
      setChecking(false);
    }
  }

  async function claimBch(utxo: ElectrumUtxo): Promise<void> {
    if (!recovery) return;
    setBusy(true);
    setActionNotice({ kind: 'info', text: 'Building the BCH claim…' });
    try {
      const txid = await broadcastBchClaim(
        recovery,
        utxo,
        endpoints.electrumUrl,
      );
      setActionNotice({ kind: 'ok', text: `BCH claim broadcast: ${txid}` });
    } catch (cause) {
      setActionNotice({
        kind: 'error',
        text: cause instanceof Error ? cause.message : 'Claim failed',
      });
    } finally {
      setBusy(false);
    }
  }

  async function refundBch(utxo: ElectrumUtxo): Promise<void> {
    if (!recovery) return;
    setBusy(true);
    setActionNotice({ kind: 'info', text: 'Building the BCH refund…' });
    try {
      const txid = await broadcastBchRefund(
        recovery,
        utxo,
        endpoints.electrumUrl,
      );
      setActionNotice({ kind: 'ok', text: `BCH refund broadcast: ${txid}` });
    } catch (cause) {
      setActionNotice({
        kind: 'error',
        text: cause instanceof Error ? cause.message : 'Refund failed',
      });
    } finally {
      setBusy(false);
    }
  }

  async function refundEvm(): Promise<void> {
    if (!recovery) return;
    const injected = (window as unknown as { ethereum?: Eip1193Provider })
      .ethereum;
    if (!injected) {
      setActionNotice({
        kind: 'error',
        text: 'No injected wallet. Send the calldata below from the Base wallet that created the lock.',
      });
      return;
    }
    setBusy(true);
    setActionNotice({ kind: 'info', text: 'Waiting for the Base wallet…' });
    try {
      const txHash = await sendEvmRefund(recovery, injected);
      setActionNotice({
        kind: 'ok',
        text: `Base refund submitted: ${txHash}`,
      });
    } catch (cause) {
      setActionNotice({
        kind: 'error',
        text: cause instanceof Error ? cause.message : 'Refund failed',
      });
    } finally {
      setBusy(false);
    }
  }

  const utxo = snapshot?.bch.ok ? snapshot.bch.utxo : null;
  const bchRefundReady = Boolean(
    recovery &&
    snapshot?.bch.ok &&
    utxo &&
    snapshot.bch.tipHeight >= recovery.terms.bchRefundHeight,
  );
  const evmLock = snapshot?.evm.ok ? snapshot.evm.lock : null;
  const evmRefundReady = Boolean(
    recovery &&
    snapshot?.evm.ok &&
    evmLock &&
    evmLock.state === 1 &&
    snapshot.evm.blockTimestamp >= Number(evmLock.deadline),
  );
  const calldata = recovery ? evmRefundCalldata(recovery) : '';

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-16">
      <p className="text-xs font-medium tracking-[0.16em] text-text-muted uppercase">
        Recovery
      </p>
      <h1 className="mt-1 font-serif text-4xl italic text-text sm:text-5xl">
        Recover a swap
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-text-muted">
        Load the recovery file you downloaded before locking. This page rebuilds
        the BCH contract address from the signed terms and checks both chains
        directly. It never asks for a seed phrase or private key.
      </p>

      <section className="mt-8 rounded-card border border-hairline bg-surface-1 p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-text">1. Load the file</h2>
        <p className="mt-1 text-xs text-text-muted">
          The secret stays in this tab. It is only revealed inside a BCH claim
          transaction you approve.
        </p>
        <label
          htmlFor="recovery-file"
          className="mt-4 block text-[10px] font-medium tracking-[0.14em] text-text-muted uppercase"
        >
          Recovery JSON file
        </label>
        <input
          id="recovery-file"
          type="file"
          accept="application/json,.json"
          onChange={(event) => void handleFile(event.target.files?.[0])}
          className="mt-1.5 w-full rounded-xl border border-hairline bg-surface-2 px-3 py-2 text-xs text-text file:mr-3 file:rounded-pill file:border-0 file:bg-olive file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-text"
        />
        {fileNotice ? (
          <p
            className={`mt-3 rounded-xl border px-3 py-2 text-xs ${noticeClass(fileNotice.kind)}`}
          >
            {fileNotice.text}
          </p>
        ) : null}
      </section>

      {recovery ? (
        <>
          <section className="mt-4 rounded-card border border-hairline bg-surface-1 p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-text">2. Check chains</h2>
            <p className="mt-1 text-xs text-text-muted">
              Public endpoints are editable. Neither endpoint receives the
              secret.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-[10px] font-medium tracking-[0.14em] text-text-muted uppercase">
                BCH Electrum WebSocket
                <input
                  type="url"
                  value={endpoints.electrumUrl}
                  onChange={(event) =>
                    setEndpoints((current) => ({
                      ...current,
                      electrumUrl: event.target.value,
                    }))
                  }
                  spellCheck={false}
                  className="mt-1.5 w-full rounded-xl border border-hairline bg-surface-2 px-3 py-2 font-mono text-xs text-text"
                />
              </label>
              <label className="text-[10px] font-medium tracking-[0.14em] text-text-muted uppercase">
                Base RPC
                <input
                  type="url"
                  value={endpoints.baseRpcUrl}
                  onChange={(event) =>
                    setEndpoints((current) => ({
                      ...current,
                      baseRpcUrl: event.target.value,
                    }))
                  }
                  spellCheck={false}
                  className="mt-1.5 w-full rounded-xl border border-hairline bg-surface-2 px-3 py-2 font-mono text-xs text-text"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={() => void checkChains()}
              disabled={checking}
              className="mt-4 inline-flex h-10 items-center rounded-pill bg-olive px-4 text-xs font-semibold text-text disabled:opacity-50"
            >
              {checking ? 'Checking…' : 'Check both chains'}
            </button>
            {chainNotice ? (
              <p
                className={`mt-3 rounded-xl border px-3 py-2 text-xs ${noticeClass(chainNotice.kind)}`}
              >
                {chainNotice.text}
              </p>
            ) : null}
          </section>

          <section className="mt-4 rounded-card border border-hairline bg-surface-1 p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-text">3. The order</h2>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-[10px] tracking-[0.14em] text-text-muted uppercase">
                  You send
                </dt>
                <dd className="mt-1 text-sm text-text">
                  {formatUsdc(recovery.terms.counterAmount)} USDC
                </dd>
              </div>
              <div>
                <dt className="text-[10px] tracking-[0.14em] text-text-muted uppercase">
                  You receive
                </dt>
                <dd className="mt-1 text-sm text-text">
                  {formatPusd(recovery.terms.bchTokenAmount)} PUSD
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[10px] tracking-[0.14em] text-text-muted uppercase">
                  BCH HTLC
                </dt>
                <dd className="mt-1 break-all font-mono text-xs text-text">
                  {recovery.contracts.bch.htlcAddress}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] tracking-[0.14em] text-text-muted uppercase">
                  BCH refund height
                </dt>
                <dd className="mt-1 font-mono text-xs text-text">
                  {recovery.terms.bchRefundHeight}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] tracking-[0.14em] text-text-muted uppercase">
                  Base lock
                </dt>
                <dd className="mt-1 font-mono text-xs text-text">
                  {truncateAddress(recovery.contracts.evm.address, 10, 8)}
                </dd>
              </div>
            </dl>
          </section>

          <section className="mt-4 rounded-card border border-hairline bg-surface-1 p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-text">4. Finish</h2>
            <p className="mt-1 text-xs text-text-muted">
              Claim the BCH branch, or take the refund branch once its deadline
              has passed.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {utxo ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void claimBch(utxo)}
                  className="inline-flex h-10 items-center rounded-pill bg-olive px-4 text-xs font-semibold text-text disabled:opacity-50"
                >
                  Claim BCH
                </button>
              ) : null}
              {utxo && bchRefundReady ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void refundBch(utxo)}
                  className="inline-flex h-10 items-center rounded-pill border border-hairline bg-surface-2 px-4 text-xs font-medium text-text disabled:opacity-50"
                >
                  Refund BCH
                </button>
              ) : null}
              {evmRefundReady ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void refundEvm()}
                  className="inline-flex h-10 items-center rounded-pill border border-hairline bg-surface-2 px-4 text-xs font-medium text-text disabled:opacity-50"
                >
                  Refund USDC with wallet
                </button>
              ) : null}
              {!snapshot ? (
                <p className="text-xs text-text-muted">
                  Check both chains to see which branch is available.
                </p>
              ) : null}
              {snapshot && !utxo && !evmRefundReady ? (
                <p className="text-xs text-text-muted">
                  No valid branch yet. Check the deadlines and chain state
                  again.
                </p>
              ) : null}
            </div>
            {evmRefundReady ? (
              <div className="mt-4 border-t border-hairline pt-4">
                <p className="text-xs font-medium text-text">
                  No injected wallet?
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  Send this calldata from the Base wallet that created the lock.
                </p>
                <textarea
                  readOnly
                  value={calldata}
                  spellCheck={false}
                  className="mt-2 min-h-20 w-full rounded-xl border border-hairline bg-surface-2 p-3 font-mono text-[10px] text-text-muted"
                />
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(calldata)
                      .then(() =>
                        setActionNotice({
                          kind: 'ok',
                          text: 'Refund calldata copied.',
                        }),
                      )
                      .catch(() =>
                        setActionNotice({
                          kind: 'error',
                          text: 'Could not copy the calldata.',
                        }),
                      );
                  }}
                  className="mt-2 text-xs text-text-muted underline underline-offset-4"
                >
                  Copy calldata
                </button>
              </div>
            ) : null}
            {actionNotice ? (
              <p
                className={`mt-3 rounded-xl border px-3 py-2 text-xs ${noticeClass(actionNotice.kind)}`}
              >
                {actionNotice.text}
              </p>
            ) : null}
          </section>
        </>
      ) : null}

      <p className="mt-6 text-xs text-text-muted">
        <Link to="/" className="underline underline-offset-4">
          Back to Ferry
        </Link>
      </p>
    </div>
  );
}
