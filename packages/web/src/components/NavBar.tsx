import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router';
import { NETWORK_LABEL } from '../lib/config';
import { GlassNav } from './GlassNav';
import { GlassPopover } from './GlassPopover';
import { InfoIcon, WalletIcon } from './icons';

const WalletSheet = lazy(async () => {
  const module = await import('./WalletSheet');
  return { default: module.WalletSheet };
});

export function NavBar() {
  const [walletOpen, setWalletOpen] = useState(false);

  return (
    <GlassNav>
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6"
      >
        <div className="flex items-center gap-8">
          <Link
            to="/"
            aria-label="Ferry home"
            className="text-[1.35rem] font-semibold tracking-[-0.04em] text-text"
          >
            Ferry<span className="text-lime">.</span>
          </Link>
          <div className="hidden items-center gap-6 md:flex">
            <a
              href="/#how-it-works"
              className="text-sm text-text-muted transition-colors hover:text-text"
            >
              How it works
            </a>
            <a
              href="/#faq"
              className="text-sm text-text-muted transition-colors hover:text-text"
            >
              FAQ
            </a>
            <Link
              to="/pay"
              className="text-sm text-text-muted transition-colors hover:text-text"
            >
              Pay links
            </Link>
            <Link
              to="/recover"
              className="text-sm text-text-muted transition-colors hover:text-text"
            >
              Recover a swap
            </Link>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <GlassPopover
            label="Network details"
            trigger={
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-pill border border-hairline bg-surface-2 px-2.5 py-1.5 text-[11px] text-text-muted transition-colors hover:text-text sm:px-3"
              >
                <span
                  className="size-1.5 rounded-full bg-ok shadow-[0_0_10px_var(--ok)]"
                  aria-hidden="true"
                />
                {NETWORK_LABEL}
                <InfoIcon className="size-3 text-text-muted" />
              </button>
            }
          >
            <p className="font-medium text-text">BCH chipnet + Base Sepolia</p>
            <p className="mt-1">
              This lab runs on test networks only. Balances and addresses here
              are not real funds.
            </p>
          </GlassPopover>
          <button
            type="button"
            onClick={() => setWalletOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={walletOpen}
            className="inline-flex h-9 items-center gap-1.5 rounded-pill bg-text px-3.5 text-xs font-semibold text-bg transition-colors hover:bg-lime hover:text-lime-ink sm:px-4"
          >
            <WalletIcon className="size-3.5" />
            Connect
          </button>
        </div>
      </nav>
      {walletOpen ? (
        <Suspense fallback={null}>
          <WalletSheet open onOpenChange={setWalletOpen} />
        </Suspense>
      ) : null}
    </GlassNav>
  );
}
