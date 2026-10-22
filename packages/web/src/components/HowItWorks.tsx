const STEPS = [
  {
    number: '01',
    title: 'Lock on the far side',
    body: 'USDC or USDT is locked in a hash-time-locked contract on the source chain.',
  },
  {
    number: '02',
    title: 'Lock on Bitcoin Cash',
    body: 'The Ferryman locks PUSD in a matching contract on BCH.',
  },
  {
    number: '03',
    title: 'One secret opens both',
    body: 'Claiming either side reveals the same 32-byte secret. If it stalls, both sides refund.',
  },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className="mt-24 scroll-mt-24 border-t border-hairline pt-12">
      <div className="grid gap-10 lg:grid-cols-[0.7fr_2fr] lg:gap-16">
        <div>
          <p className="text-[10px] font-medium tracking-[0.18em] text-lime uppercase">
            How it works
          </p>
          <h2 className="mt-3 text-2xl font-medium tracking-[-0.03em] text-text sm:text-3xl">
            Two locks. One secret.
          </h2>
          <p className="mt-3 max-w-sm text-sm leading-6 text-text-muted">
            Every swap is two hash-time-locked contracts. Either both sides complete, or both
            refund.
          </p>
        </div>

        <ol className="grid gap-6 sm:grid-cols-3">
          {STEPS.map((step) => (
            <li key={step.number} className="border-t border-hairline pt-5">
              <span className="font-mono text-[11px] text-lime">{step.number}</span>
              <h3 className="mt-3 text-sm font-semibold text-text">{step.title}</h3>
              <p className="mt-2 text-xs leading-5 text-text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
