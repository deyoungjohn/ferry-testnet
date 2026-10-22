import type { ReactNode } from 'react';
import { Link } from 'react-router';

export interface PlaceholderPageProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly detail?: ReactNode;
}

export function PlaceholderPage({
  eyebrow,
  title,
  description,
  detail,
}: PlaceholderPageProps) {
  return (
    <section className="mx-auto flex max-w-6xl flex-col items-start px-4 pt-16 pb-24 sm:px-6 sm:pt-24">
      <p className="text-[10px] font-medium tracking-[0.18em] text-lime uppercase">
        {eyebrow}
      </p>
      <h1 className="mt-4 text-4xl font-medium tracking-[-0.04em] text-text sm:text-5xl">
        {title}
      </h1>
      <p className="mt-4 max-w-xl text-base leading-7 text-text-muted">
        {description}
      </p>
      {detail ? (
        <p className="mt-6 rounded-pill border border-hairline bg-surface-1 px-4 py-2 font-mono text-xs text-text-muted">
          {detail}
        </p>
      ) : null}
      <Link
        to="/"
        className="mt-10 text-sm text-text-muted transition-colors hover:text-lime"
      >
        ← Back to the swap
      </Link>
    </section>
  );
}
