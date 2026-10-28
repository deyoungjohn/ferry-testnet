import { useEffect, useState } from 'react';
import { useWallets } from '../lib/wallet/context';

const SLOW_REQUEST_SECONDS = 30;

export function WalletActivityBanner() {
  const { bch, evm } = useWallets();
  const request = evm.pendingRequest ?? bch.pendingRequest ?? null;
  const cancel =
    !evm.pendingRequest && bch.pendingRequest
      ? (bch.cancelPendingRequest ?? null)
      : null;
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    setWaited(0);
    if (!request) return;
    const timer = window.setInterval(() => setWaited((s) => s + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [request]);

  if (!request) return null;

  return (
    <div
      role="status"
      aria-live="assertive"
      className="border-b border-warn/25 bg-warn/10 px-4 py-2 text-[11px] leading-5 text-warn"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">
          Waiting for your wallet: {request}.
        </span>
        <span>
          Confirm it in your wallet. If no popup appeared, open your wallet
          extension.
        </span>
        {waited >= SLOW_REQUEST_SECONDS ? (
          <span>
            Still waiting ({waited.toString()}s). Is your phone asleep? Wake the
            wallet app, or cancel and try again.
          </span>
        ) : null}
        {cancel ? (
          <button
            type="button"
            onClick={cancel}
            className="rounded-pill border border-warn/40 bg-warn/15 px-2.5 py-0.5 font-semibold text-warn"
          >
            Cancel request
          </button>
        ) : null}
      </div>
    </div>
  );
}
