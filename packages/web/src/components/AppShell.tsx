import { Outlet } from 'react-router';
import { GlassLayerProvider } from './GlassLayerProvider';
import { BannerBar } from './BannerBar';
import { NetworkBanner } from './NetworkBanner';
import { NetworkBlockedPage } from './NetworkBlockedPage';
import { NETWORK_CONFIG_ERRORS } from '../lib/config';
import { Footer } from './Footer';
import { ToastProvider } from './GlassToast';
import { WalletActivityBanner } from './WalletActivityBanner';
import { NavBar } from './NavBar';

export function AppShell() {
  return (
    <GlassLayerProvider>
      <ToastProvider>
        <div className="ferry-page flex min-h-dvh flex-col">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-pill focus:bg-lime focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-lime-ink"
          >
            Skip to content
          </a>
          <NetworkBanner />
          <BannerBar />
          <WalletActivityBanner />
          <NavBar />
          <main id="main" className="flex-1">
            {NETWORK_CONFIG_ERRORS.length > 0 ? (
              <NetworkBlockedPage />
            ) : (
              <Outlet />
            )}
          </main>
          <Footer />
        </div>
      </ToastProvider>
    </GlassLayerProvider>
  );
}
