import { solverIsLive } from '../lib/solver/kind';

export function Footer() {
  return (
    <footer className="mt-20 border-t border-hairline">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-[11px] text-text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>Ferry · practice lab. Bitcoin Cash is the hub.</p>
        <p>
          {solverIsLive()
            ? 'Testnet solver connected — test funds only.'
            : 'Mock interface — no funds move.'}
        </p>
      </div>
    </footer>
  );
}
