import { Route, Routes } from 'react-router';
import { AppShell } from './components/AppShell';
import { HomePage } from './routes/HomePage';
import { NotFoundPage } from './routes/NotFoundPage';
import { PayLinkPage } from './routes/PayLinkPage';
import { RecoverPage } from './routes/RecoverPage';
import { SwapStatusPage } from './routes/SwapStatusPage';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="swap/:orderId" element={<SwapStatusPage />} />
        <Route path="recover" element={<RecoverPage />} />
        <Route path="p/:linkId" element={<PayLinkPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
