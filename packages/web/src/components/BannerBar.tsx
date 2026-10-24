import { BANNER } from '../lib/config';

export function BannerBar() {
  return (
    <aside
      aria-label="Project links"
      className="border-b border-hairline bg-surface-1/40 text-[11px] text-text-muted"
    >
      <div className="mx-auto flex h-9 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <p className="truncate">
          Built on prior work
          <span className="hidden sm:inline">
            : <span className="text-text">{BANNER.priorWork}</span>
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden sm:inline">Deck</span>
          <span className="hidden sm:inline">Repo</span>
          <span
            className="hidden h-3 w-px bg-hairline sm:block"
            aria-hidden="true"
          />
          <span className="inline-flex items-center gap-1.5">
            <span className="font-medium text-text-muted">EMBER2026</span>
            <span className="font-mono">{BANNER.emberAddress}</span>
          </span>
        </div>
      </div>
    </aside>
  );
}
