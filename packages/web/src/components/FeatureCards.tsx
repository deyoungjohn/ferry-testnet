import { formatBasisPoints, formatUsdMicros } from '../lib/format';
import type { DataResource, StatsSummary } from '../lib/stats/types';

export function FeatureCards({
  stats,
}: {
  readonly stats: DataResource<StatsSummary>;
}) {
  const policy = stats.status === 'ready' ? stats.data.quotePolicy : null;
  const features = [
    {
      number: '01',
      title: 'No bridge, no custodian',
      body: 'Two contracts hold the assets. Ferry never wraps them and Ferryman never takes custody.',
    },
    {
      number: '02',
      title: 'Refunds are automatic',
      body: 'Each lock has a deadline and a refund branch you can use without the solver.',
    },
    {
      number: '03',
      title: 'Gas-free on Base',
      body: 'You sign a permit and lock intent. Ferryman relays the Base transaction and pays gas.',
    },
    {
      number: '04',
      title: policy
        ? `${formatBasisPoints(policy.spreadBps)} spread`
        : 'Published spread',
      body: policy
        ? `Current quote policy, plus a ${formatUsdMicros(policy.fixedFeeUsdMicros)} fixed fee.`
        : 'The active quote policy appears here when the solver reports it.',
    },
  ] as const;

  return (
    <section aria-labelledby="features-heading" className="mt-20">
      <div className="max-w-2xl">
        <p className="text-[10px] font-medium tracking-[0.18em] text-lime uppercase">
          Built differently
        </p>
        <h2
          id="features-heading"
          className="mt-3 text-2xl font-medium tracking-[-0.03em] text-text sm:text-3xl"
        >
          The route is the product
        </h2>
      </div>

      <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {features.map((feature) => (
          <article
            key={feature.number}
            className="relative min-h-52 overflow-hidden rounded-card border border-hairline bg-surface-1 p-5 sm:p-6"
          >
            <span
              aria-hidden="true"
              className="absolute -top-5 right-3 font-mono text-[5rem] leading-none text-white/[0.025]"
            >
              {feature.number}
            </span>
            <span className="font-mono text-[10px] text-lime">
              {feature.number}
            </span>
            <h3 className="mt-10 max-w-[13rem] text-base font-semibold tracking-[-0.02em] text-text">
              {feature.title}
            </h3>
            <p className="mt-3 text-xs leading-5 text-text-muted">
              {feature.body}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
