import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { OrderTerms } from '@ferry/core';
import { PUSD_SYMBOL, SOLVER_BCH_ADDRESS } from '../lib/config';
import {
  assertReverseFundingTarget,
  buildMockReverseLock,
  buildReverseLock,
} from '../lib/bch/lock';
import { parseBchAddress } from '../lib/bch/address';
import { formatPusd, truncateAddress } from '../lib/swap';
import { useWallets } from '../lib/wallet/context';
import { CheckIcon } from './icons';

const solverBch = parseBchAddress(SOLVER_BCH_ADDRESS);
if (!solverBch.ok) throw new Error(solverBch.error);
const solverBchLockingBytecode = solverBch.value.lockingBytecode;

export interface ReverseFundingPanelProps {
  readonly terms: OrderTerms;
  readonly onFunded: (txid: string) => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}

export function ReverseFundingPanel({
  terms,
  onFunded,
  disabled = false,
  disabledReason,
}: ReverseFundingPanelProps) {
  const { bch, usingMocks } = useWallets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  let target: ReturnType<typeof assertReverseFundingTarget> | null = null;
  let targetError: string | null = null;
  try {
    if (!bch.address) throw new Error('Connect the BCH wallet first');
    target = assertReverseFundingTarget(
      terms,
      bch.address.lockingBytecode,
      solverBchLockingBytecode,
    );
  } catch (cause) {
    targetError =
      cause instanceof Error ? cause.message : 'Could not derive the BCH lock';
  }

  async function handleSign(): Promise<void> {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const utxos = await bch.listUtxos();
      const build = usingMocks
        ? buildMockReverseLock({
            terms,
            utxos,
            changeAddress: bch.address?.address ?? '',
          })
        : buildReverseLock({
            terms,
            utxos,
            changeAddress: bch.address?.address ?? '',
          });
      const signed = await bch.signTransaction(build.wcSignRequest);
      const txid = await bch.broadcastTransaction(signed.txHex);
      onFunded(txid);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not fund the BCH lock',
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyAddress(): Promise<void> {
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.htlcTokenAddress);
      setCopied(true);
    } catch {
      setError('Could not copy the address; select it manually');
    }
  }

  return (
    <div className="mt-4 rounded-well border border-hairline bg-surface-2/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-medium tracking-[0.14em] text-text-muted uppercase">
            Fund the BCH lock
          </p>
          <p className="mt-0.5 text-xs text-text">
            Send {formatPusd(terms.bchTokenAmount)} {PUSD_SYMBOL} +{' '}
            {terms.bchCarrySats.toString()} sats carry into the HTLC.
          </p>
        </div>
        <span className="rounded-pill bg-olive-soft px-2 py-0.5 text-[9px] font-medium tracking-[0.14em] text-lime uppercase ring-1 ring-lime/15">
          Reverse
        </span>
      </div>

      {targetError || !target ? (
        <p role="alert" className="mt-3 text-[11px] leading-5 text-danger">
          {targetError ?? 'The BCH funding target is unavailable'}
        </p>
      ) : disabled ? (
        <p className="mt-3 rounded-well border border-hairline bg-surface-1 px-3 py-2 text-[11px] leading-5 text-text-muted">
          {disabledReason ?? 'Funding is not available yet.'}
        </p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
            <div>
              <p className="text-text-muted">Token-aware address</p>
              <p
                aria-label="BCH HTLC token address"
                className="mt-0.5 truncate font-mono text-text"
                title={target.htlcTokenAddress}
              >
                {truncateAddress(target.htlcTokenAddress, 16, 10)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-text-muted">Amount</p>
              <p className="mt-0.5 font-medium tabular-nums text-text">
                {formatPusd(target.tokenAmount)} {PUSD_SYMBOL}
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleSign()}
              disabled={busy || disabled}
              title={disabled ? disabledReason : undefined}
              className="flex h-10 flex-1 items-center justify-center rounded-pill bg-olive px-4 text-xs font-semibold text-text shadow-pill disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Signing BCH funding…' : 'Sign with BCH wallet'}
            </button>
            <button
              type="button"
              onClick={() => void copyAddress()}
              className="flex h-10 items-center justify-center rounded-pill border border-hairline bg-surface-3 px-4 text-xs font-medium text-text"
            >
              {copied ? (
                <>
                  <CheckIcon className="mr-1 size-3.5 text-ok" />
                  Copied
                </>
              ) : (
                'Copy address'
              )}
            </button>
          </div>

          <details className="mt-3 border-t border-hairline pt-3 text-[11px] text-text-muted">
            <summary className="cursor-pointer select-none hover:text-text">
              QR / manual funding fallback
            </summary>
            <div className="mt-3 flex flex-col items-center gap-2 rounded-well bg-surface-1 p-3">
              <QRCodeSVG
                value={target.htlcTokenAddress}
                size={168}
                bgColor="var(--surface-1)"
                fgColor="var(--text)"
                aria-label="QR code for the BCH HTLC token address"
              />
              <p className="text-center font-mono text-[10px] break-all text-text">
                {target.htlcTokenAddress}
              </p>
              <p className="text-center text-[10px] leading-4 text-warn">
                Send exactly {formatPusd(target.tokenAmount)} {PUSD_SYMBOL} to
                this token-aware address. A different amount or address will not
                be detected by the solver.
              </p>
            </div>
          </details>

          {!usingMocks ? (
            <p className="mt-2 text-[10px] leading-4 text-text-muted">
              WizardConnect signing is unavailable until the shared BCH lock
              builder lands; the QR/manual path works now.
            </p>
          ) : null}
        </>
      )}

      {error ? (
        <p role="alert" className="mt-2 text-[11px] leading-5 text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
