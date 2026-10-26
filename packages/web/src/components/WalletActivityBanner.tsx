import { useWallets } from '../lib/wallet/context';

export function WalletActivityBanner() {
  const { bch, evm } = useWallets();
  const request = evm.pendingRequest ?? bch.pendingRequest ?? null;
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
      </div>
    </div>
  );
}
