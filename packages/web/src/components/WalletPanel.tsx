import { useState, type FormEvent } from 'react';
import { useWallets } from '../lib/wallet/context';
import { truncateAddress } from '../lib/swap';

export function WalletPanel() {
  const { bch, evm } = useWallets();
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);

  async function handlePaste(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const { parseBchAddress } = await import('../lib/bch/address');
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
    <div className="rounded-well border border-hairline bg-surface-2/60 p-3">
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
        <form
          onSubmit={(event) => void handlePaste(event)}
          className="mt-2 flex gap-2"
        >
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
  );
}
