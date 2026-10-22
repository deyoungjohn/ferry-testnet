import { CheckIcon } from './icons';

const PROOF_POINTS = [
  'Non-custodial',
  'Automatic refunds',
  'No wrapped assets',
] as const;

export function Hero() {
  return (
    <div>
      <p className="inline-flex items-center gap-2 rounded-pill border border-hairline bg-surface-1/60 px-3 py-1 text-[10px] font-medium tracking-[0.18em] text-text-muted uppercase">
        <span className="size-1.5 rounded-full bg-lime" aria-hidden="true" />
        Bitcoin Cash is the hub
      </p>

      <h1 className="mt-6 text-balance text-[2.75rem] leading-[0.98] font-medium tracking-[-0.045em] text-text sm:text-6xl lg:text-[4.5rem]">
        Move dollars onto Bitcoin Cash{' '}
        <em className="font-accent text-lime italic text-glow">
          without a bridge
        </em>
      </h1>

      <p className="mt-6 max-w-xl text-pretty text-base leading-7 text-text-muted sm:text-lg">
        Swap USDC or USDT from seven networks for PUSD or MUSD, both ways.
        Nothing wrapped. Nobody holds your money.
      </p>

      <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2.5 text-sm text-text-muted">
        {PROOF_POINTS.map((point) => (
          <li key={point} className="inline-flex items-center gap-1.5">
            <CheckIcon className="size-3.5 text-lime" />
            {point}
          </li>
        ))}
      </ul>

      <p className="mt-8 text-xs text-text-muted">
        BCH wallet first. Every route lands on Bitcoin Cash.
      </p>
    </div>
  );
}
