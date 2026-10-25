import type { ReactNode } from 'react';
import { useGlassLens } from '../lib/glass';
import { useGlassLayer } from '../lib/glass-layer';
import { useScrolled } from '../lib/useScrolled';

export function GlassNav({ children }: { readonly children: ReactNode }) {
  const scrolled = useScrolled(24);
  const lensed = useGlassLens();
  useGlassLayer(scrolled, 'nav');

  return (
    <header
      data-scrolled={scrolled ? 'true' : 'false'}
      className={[
        'sticky top-0 z-40 transition-[background-color,border-color,box-shadow] duration-300',
        scrolled
          ? `glass glass-nav ${lensed ? 'glass--lensed' : ''}`
          : 'border-b border-transparent bg-transparent',
      ].join(' ')}
    >
      {children}
    </header>
  );
}
