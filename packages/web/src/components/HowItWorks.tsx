import { ArrowRightIcon, KeyIcon, LockIcon } from './icons';

const STEPS = [
  {
    number: '01',
    eyebrow: 'Source chain',
    title: 'You lock dollars',
    body: 'USDC or USDT enters a hash-time-locked contract. The solver cannot move it without the secret.',
    icon: LockIcon,
  },
  {
    number: '02',
    eyebrow: 'Bitcoin Cash',
    title: 'Ferryman matches the lock',
    body: 'PUSD or MUSD enters a BCH covenant with the same hash and a safer, later refund window.',
    icon: LockIcon,
  },
  {
    number: '03',
    eyebrow: 'Shared proof',
    title: 'One secret opens both',
    body: 'Your claim reveals one 32-byte secret. Ferryman uses that same public proof to settle the other chain.',
    icon: KeyIcon,
  },
] as const;

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="mt-24 scroll-mt-24 border-t border-hairline pt-12"
      aria-labelledby="how-it-works-heading"
    >
      <div className="grid gap-8 lg:grid-cols-[0.72fr_2fr] lg:gap-14">
        <div>
          <p className="text-[10px] font-medium tracking-[0.18em] text-lime uppercase">
            How it works
          </p>
          <h2
            id="how-it-works-heading"
            className="mt-3 text-2xl font-medium tracking-[-0.03em] text-text sm:text-3xl"
          >
            Two locks. One secret.
          </h2>
          <p className="mt-3 max-w-sm text-sm leading-6 text-text-muted">
            The route is atomic, not bridged. Both directions use the same
            pattern: either each side settles, or each side becomes refundable.
          </p>
          <div className="mt-6 inline-flex items-center gap-2 rounded-pill border border-hairline bg-surface-1 px-3 py-2 text-[11px] text-text-muted">
            <span className="size-1.5 rounded-full bg-ok" aria-hidden="true" />
            No shared custodian between chains
          </div>
        </div>

        <ol
          className="relative grid gap-3 md:grid-cols-3"
          aria-label="Atomic swap flow"
        >
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            return (
              <li
                key={step.number}
                className="relative rounded-card border border-hairline bg-surface-1 p-5 sm:p-6"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[10px] text-lime">
                    {step.number}
                  </span>
                  <span className="grid size-9 place-items-center rounded-full border border-hairline bg-surface-2 text-text-muted">
                    <Icon className="size-4" />
                  </span>
                </div>
                <p className="mt-8 text-[10px] tracking-[0.14em] text-text-muted uppercase">
                  {step.eyebrow}
                </p>
                <h3 className="mt-2 text-sm font-semibold text-text">
                  {step.title}
                </h3>
                <p className="mt-2 text-xs leading-5 text-text-muted">
                  {step.body}
                </p>

                {index < STEPS.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="absolute -right-3 bottom-1/2 z-10 hidden size-6 translate-x-1/2 translate-y-1/2 place-items-center rounded-full border border-hairline bg-bg text-lime md:grid"
                  >
                    <ArrowRightIcon className="size-3.5" />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-well border border-hairline bg-surface-1/60 px-4 py-3 text-[11px] text-text-muted sm:px-5">
        <span className="font-medium text-text">If the happy path stops:</span>
        <span>Your source lock refunds after its deadline.</span>
        <span
          className="hidden size-1 rounded-full bg-text-muted sm:block"
          aria-hidden="true"
        />
        <span>The BCH lock refunds at its block height.</span>
      </div>
    </section>
  );
}
