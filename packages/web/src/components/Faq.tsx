const ITEMS = [
  {
    question: 'Can PUSD or MUSD move away from one dollar?',
    answer:
      'Yes. Ferry moves the token; it does not guarantee the issuer, redemption path, market liquidity or peg. Check the live peg card and the stablecoin’s own terms before swapping.',
  },
  {
    question: 'What happens when a swap takes too long?',
    answer:
      'Each contract has a separate timeout. A claim can still win before the relevant refund is mined; after the refund branch becomes valid, the original locker can recover that side. The status page shows both deadlines.',
  },
  {
    question: 'What is the fast, or 0-conf, lane?',
    answer:
      'For small swaps, Ferryman may react to a BCH transaction before it confirms. That improves speed but adds double-spend and reorg risk. It is optional and capped; the safe lane waits for a BCH block.',
  },
  {
    question: 'What if Ferryman disappears halfway through?',
    answer:
      'Ferryman cannot take both sides. If no matching lock appears, wait for your refund deadline and recover your original asset. If the matching lock already exists, your recovery file contains what the standalone recovery page needs to claim or refund.',
  },
  {
    question: 'Why must I download a recovery file?',
    answer:
      'It carries the secret and contract details needed when this browser or the solver is unavailable. Ferry offers it before funding. Treat it as sensitive: anyone with the secret may be able to claim the intended recipient branch.',
  },
] as const;

export function Faq() {
  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      className="mt-24 scroll-mt-24 border-t border-hairline pt-12"
    >
      <div className="grid gap-8 lg:grid-cols-[0.72fr_2fr] lg:gap-14">
        <div>
          <p className="text-[10px] font-medium tracking-[0.18em] text-lime uppercase">
            FAQ
          </p>
          <h2
            id="faq-heading"
            className="mt-3 text-2xl font-medium tracking-[-0.03em] text-text sm:text-3xl"
          >
            The honest version
          </h2>
          <p className="mt-3 max-w-sm text-sm leading-6 text-text-muted">
            Atomic does not mean risk-free. These are the failure modes to
            understand before you fund a lock.
          </p>
        </div>

        <div className="divide-y divide-hairline border-y border-hairline">
          {ITEMS.map((item) => (
            <details key={item.question} className="group py-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-5 py-5 text-sm font-medium text-text marker:hidden">
                <span>{item.question}</span>
                <span
                  aria-hidden="true"
                  className="grid size-7 shrink-0 place-items-center rounded-full border border-hairline bg-surface-1 text-lg font-light text-text-muted transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="max-w-2xl pb-5 pr-10 text-xs leading-6 text-text-muted sm:text-sm">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
