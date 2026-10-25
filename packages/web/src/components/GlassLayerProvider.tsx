import { useMemo, type ReactNode } from 'react';
import { GlassLayerBudget, GlassLayerContext } from '../lib/glass-layer';

export function GlassLayerProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const budget = useMemo(() => new GlassLayerBudget(), []);
  return (
    <GlassLayerContext.Provider value={budget}>
      {children}
    </GlassLayerContext.Provider>
  );
}
