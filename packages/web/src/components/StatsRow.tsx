import { formatUsdMicros, formatUtcTimestamp } from '../lib/format';
import { formatDuration } from '../lib/solver/view';
import type { DataResource, StatsSummary } from '../lib/stats/types';

function metricValue<T extends number | bigint>(
  resource: DataResource<StatsSummary>,
  value: T | null,
  format: (input: T) => string,
): string {
  if (resource.status === 'loading') return 'Loading…';
  if (resource.status === 'error') return 'Unavailable';
  if (value === null) return 'No data yet';
  return format(value);
}

export function StatsRow({
  resource,
}: {
  readonly resource: DataResource<StatsSummary>;
}) {
  const summary = resource.status === 'ready' ? resource.data : null;
  const metrics = [
    {
      label: 'Completed swaps',
      value: metricValue(
        resource,
        summary?.completedSwaps ?? null,
        (value: number) => value.toLocaleString('en-US'),
      ),
      detail: 'Settled on both chains',
    },
    {
      label: 'Volume',
      value: metricValue(
        resource,
        summary?.volumeUsdMicros ?? null,
        (value: bigint) => formatUsdMicros(value),
      ),
      detail: 'Completed USD value',
    },
    {
      label: 'Median time',
      value: metricValue(
        resource,
        summary?.medianFastSeconds ?? null,
        (value: number) => formatDuration(value),
      ),
      detail: 'Fast lane only',
    },
  ] as const;

  return (
    <section
      aria-labelledby="stats-heading"
      className="mt-24 border-t border-hairline pt-12"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-medium tracking-[0.18em] text-lime uppercase">
            Network proof
          </p>
          <h2
            id="stats-heading"
            className="mt-3 text-2xl font-medium tracking-[-0.03em] text-text sm:text-3xl"
          >
            What Ferry has settled
          </h2>
        </div>
        {summary?.asOf ? (
          <p className="text-[11px] text-text-muted">
            Updated {formatUtcTimestamp(summary.asOf)}
          </p>
        ) : null}
      </div>

      <div
        className="mt-7 grid overflow-hidden rounded-card border border-hairline bg-surface-1 sm:grid-cols-3"
        aria-live="polite"
      >
        {metrics.map((metric, index) => (
          <div
            key={metric.label}
            className={[
              'px-5 py-5 sm:px-7 sm:py-6',
              index > 0
                ? 'border-t border-hairline sm:border-t-0 sm:border-l'
                : '',
            ].join(' ')}
          >
            <p className="text-[10px] tracking-[0.14em] text-text-muted uppercase">
              {metric.label}
            </p>
            <p className="mt-2 text-xl font-medium tracking-[-0.025em] text-text tabular-nums sm:text-2xl">
              {metric.value}
            </p>
            <p className="mt-1 text-[11px] text-text-muted">{metric.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
