import '@fontsource-variable/inter';
import '@fontsource/instrument-serif/latin-400-italic.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { SolverProvider } from './lib/solver/SolverProvider';
import { StatsProvider } from './lib/stats/StatsProvider';
import { WalletProvider } from './lib/wallet/WalletProvider';
import './styles/index.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <SolverProvider>
          <StatsProvider>
            <App />
          </StatsProvider>
        </SolverProvider>
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>,
);
