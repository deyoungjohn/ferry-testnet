import { Outlet } from 'react-router';
import { BannerBar } from './BannerBar';
import { Footer } from './Footer';
import { NavBar } from './NavBar';

export function AppShell() {
  return (
    <div className="ferry-page flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-pill focus:bg-lime focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-lime-ink"
      >
        Skip to content
      </a>
      <BannerBar />
      <NavBar />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
