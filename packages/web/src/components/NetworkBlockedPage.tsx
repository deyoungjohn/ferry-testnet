import { NETWORK_PROFILE } from '../lib/config';
import { networkConfigErrors, type NetworkProfile } from '../lib/network';

export interface NetworkBlockedPageProps {
  readonly profile?: NetworkProfile;
  readonly errors?: readonly string[];
}

export function NetworkBlockedPage({
  profile = NETWORK_PROFILE,
  errors,
}: NetworkBlockedPageProps) {
  const messages = errors ?? networkConfigErrors(profile);
  return (
    <section className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
      <p className="text-[10px] font-semibold tracking-[0.2em] text-danger uppercase">
        Network profile blocked
      </p>
      <h1 className="mt-3 font-serif text-4xl italic text-text sm:text-5xl">
        {profile.label} is not configured for real funds.
      </h1>
      <p className="mt-4 max-w-xl text-sm leading-6 text-text-muted">
        Ferry fails closed before any quote, lock or recovery action. Every
        mainnet value must be verified in <code>lab/verified-facts.md</code> and
        added to the mainnet profile. No funds can move in this state.
      </p>
      <ul className="mt-6 space-y-2 rounded-well border border-danger/25 bg-danger/5 p-4 text-xs leading-5 text-danger">
        {messages.map((error) => (
          <li key={error}>• {error}</li>
        ))}
      </ul>
      <p className="mt-4 text-[11px] leading-5 text-text-muted">
        PUSD and MUSD mainnet categories intentionally remain empty until the
        human confirms them. Do not fill them from memory or a testnet value.
      </p>
    </section>
  );
}
