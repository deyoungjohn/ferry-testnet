import { NETWORK_PROFILE } from '../lib/config';
import type { NetworkProfile } from '../lib/network';

export function NetworkBanner({
  profile = NETWORK_PROFILE,
}: {
  readonly profile?: NetworkProfile;
}) {
  if (!profile.isMainnet) return null;
  return (
    <aside
      role="alert"
      aria-label="Mainnet warning"
      className="border-b border-danger/50 bg-danger/15 px-4 py-2 text-center text-[11px] font-semibold tracking-[0.08em] text-danger uppercase sm:px-6"
    >
      Mainnet · real funds · irreversible transactions
    </aside>
  );
}
