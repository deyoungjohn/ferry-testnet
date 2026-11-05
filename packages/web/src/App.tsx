import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { AppShell } from './components/AppShell';
import { HomePage } from './routes/HomePage';
import { NotFoundPage } from './routes/NotFoundPage';

const SwapStatusPage = lazy(async () => {
  const module = await import('./routes/SwapStatusPage');
  return { default: module.SwapStatusPage };
});
const RecoverPage = lazy(async () => {
  const module = await import('./routes/RecoverPage');
  return { default: module.RecoverPage };
});
const ActivityPage = lazy(async () => {
  const module = await import('./routes/ActivityPage');
  return { default: module.ActivityPage };
});
const PayLinkPage = lazy(async () => {
  const module = await import('./routes/PayLinkPage');
  return { default: module.PayLinkPage };
});
const PayLinksPage = lazy(async () => {
  const module = await import('./routes/PayLinksPage');
  return { default: module.PayLinksPage };
});

const WalletExtensionSpikePage =
  import.meta.env.DEV && import.meta.env.VITE_WALLET_EXTENSION_SPIKE === '1'
    ? lazy(async () => {
        const module = await import('./routes/WalletExtensionSpikePage');
        return { default: module.WalletExtensionSpikePage };
      })
    : null;

function RouteLoading() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
      <p className="text-sm text-text-muted" role="status">
        Loading page…
      </p>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route
          path="swap/:orderId"
          element={
            <Suspense fallback={<RouteLoading />}>
              <SwapStatusPage />
            </Suspense>
          }
        />
        <Route
          path="recover"
          element={
            <Suspense fallback={<RouteLoading />}>
              <RecoverPage />
            </Suspense>
          }
        />
        <Route
          path="activity"
          element={
            <Suspense fallback={<RouteLoading />}>
              <ActivityPage />
            </Suspense>
          }
        />
        <Route
          path="pay"
          element={
            <Suspense fallback={<RouteLoading />}>
              <PayLinksPage />
            </Suspense>
          }
        />
        <Route
          path="p/:linkId"
          element={
            <Suspense fallback={<RouteLoading />}>
              <PayLinkPage />
            </Suspense>
          }
        />
        {WalletExtensionSpikePage ? (
          <Route
            path="dev/wallet-extension"
            element={
              <Suspense fallback={<RouteLoading />}>
                <WalletExtensionSpikePage />
              </Suspense>
            }
          />
        ) : null}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
