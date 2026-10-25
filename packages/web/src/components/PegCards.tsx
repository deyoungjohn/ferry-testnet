import { useId } from 'react';
import {
  formatBasisPoints,
  formatUsdMicros,
  formatUtcTimestamp,
} from '../lib/format';
import { sparklineCoordinates } from '../lib/stats/sparkline';
import type { DataResource, PegSnapshot, PegToken } from '../lib/stats/types';

const TARGET_USD_MICROS = 1_000_000n;
const TOKENS: readonly PegToken[] = ['PUSD', 'MUSD'];

function deviation(price: bigint): string {
  const bps = Number(
    ((price - TARGET_USD_MICROS) * 10_000n) / TARGET_USD_MICROS,
  );
  const prefix = bps > 0 ? '+' : '';
  return `${prefix}${formatBasisPoints(bps)} vs $1`;
}

function PegSparkline({ peg }: { readonly peg: PegSnapshot }) {
  const titleId = useId();
  const descriptionId = useId();
  const geometry = sparklineCoordinates(peg.points);
  if (!geometry || peg.priceUsdMicros === null) return null;

  const prices = peg.points.map((point) => point.priceUsdMicros);
  const low = prices.reduce((value, point) => (point < value ? point : value));
  const high = prices.reduce((value, point) => (point > value ? point : value));
  const final = geometry.line.split(' ').at(-1)?.split(',') ?? ['0', '0'];

  return (
    <figure className="mt-5">
      <svg
        viewBox="0 0 240 72"
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
        className="h-24 w-full overflow-visible text-lime"
        preserveAspectRatio="none"
      >
        <title id={titleId}>{peg.token} price over the last 24 hours</title>
        <desc id={descriptionId}>
          {peg.points.length.toString()} observations. Latest{' '}
          {formatUsdMicros(peg.priceUsdMicros, 4)}, low{' '}
          {formatUsdMicros(low, 4)}, high {formatUsdMicros(high, 4)}. The dashed
          line marks one dollar.
        </desc>
        <line
          x1="0"
          x2="240"
          y1={geometry.targetY}
          y2={geometry.targetY}
          className="stroke-text-muted/35"
          strokeDasharray="4 5"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={geometry.line}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={final[0]}
          cy={final[1]}
          r="3"
          fill="currentColor"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="mt-1 flex justify-between gap-3 text-[10px] text-text-muted tabular-nums">
        <span>24 h range</span>
        <span>
          {formatUsdMicros(low, 4)}–{formatUsdMicros(high, 4)}
        </span>
      </figcaption>
    </figure>
  );
}

function PegCard({
  token,
  peg,
  state,
}: {
  readonly token: PegToken;
  readonly peg: PegSnapshot | null;
  readonly state: DataResource<readonly PegSnapshot[]>['status'];
}) {
  const price = peg?.priceUsdMicros ?? null;
  const hasSeries = Boolean(peg && peg.points.length >= 2 && price !== null);
  const noData =
    state === 'loading'
      ? 'Loading price data…'
      : state === 'error'
        ? 'Price feed unavailable.'
        : 'No 24 h observations yet.';

  return (
    <article className="rounded-card border border-hairline bg-surface-1 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] tracking-[0.14em] text-text-muted uppercase">
            Bitcoin Cash stablecoin
          </p>
          <h3 className="mt-2 text-lg font-semibold text-text">{token}</h3>
        </div>
        <span className="rounded-pill border border-hairline bg-surface-2 px-2.5 py-1 text-[10px] text-text-muted">
          24 h
        </span>
      </div>

      {price === null ? (
        <p className="mt-7 text-xl font-medium text-text-muted tabular-nums">
          No price yet
        </p>
      ) : (
        <div className="mt-7 flex items-baseline gap-3">
          <p className="text-3xl font-medium tracking-[-0.04em] text-text tabular-nums">
            {formatUsdMicros(price, 4)}
          </p>
          <p
            className={[
              'text-xs tabular-nums',
              price === TARGET_USD_MICROS ? 'text-ok' : 'text-warn',
            ].join(' ')}
          >
            {deviation(price)}
          </p>
        </div>
      )}

      {hasSeries && peg ? (
        <PegSparkline peg={peg} />
      ) : (
        <div
          className="mt-5 grid h-24 place-items-center rounded-well border border-dashed border-hairline bg-surface-2/40 px-4 text-center text-xs text-text-muted"
          role="status"
        >
          {noData}
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-between gap-2 border-t border-hairline pt-3 text-[10px] text-text-muted">
        <span>
          {peg?.source ? `Source: ${peg.source}` : 'No source reported'}
        </span>
        {peg?.asOf ? <span>{formatUtcTimestamp(peg.asOf)}</span> : null}
      </div>
    </article>
  );
}

export function PegCards({
  resource,
}: {
  readonly resource: DataResource<readonly PegSnapshot[]>;
}) {
  const pegs = resource.status === 'ready' ? resource.data : [];

  return (
    <section
      aria-labelledby="pegs-heading"
      className="mt-24 border-t border-hairline pt-12"
    >
      <div className="max-w-2xl">
        <p className="text-[10px] font-medium tracking-[0.18em] text-lime uppercase">
          Peg watch
        </p>
        <h2
          id="pegs-heading"
          className="mt-3 text-2xl font-medium tracking-[-0.03em] text-text sm:text-3xl"
        >
          A dollar target, not a promise
        </h2>
        <p className="mt-3 text-sm leading-6 text-text-muted">
          Live PUSD and MUSD observations belong here. Ferry never invents a
          price or fills gaps with a decorative series.
        </p>
      </div>

      <div className="mt-7 grid gap-4 md:grid-cols-2">
        {TOKENS.map((token) => (
          <PegCard
            key={token}
            token={token}
            peg={pegs.find((peg) => peg.token === token) ?? null}
            state={resource.status}
          />
        ))}
      </div>
    </section>
  );
}
