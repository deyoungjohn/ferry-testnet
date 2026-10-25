import { createContext, useContext, useEffect } from 'react';

export const MAX_GLASS_LAYERS = 2;

export class GlassLayerBudget {
  readonly #limit: number;
  readonly #active = new Set<symbol>();

  constructor(limit = MAX_GLASS_LAYERS) {
    this.#limit = limit;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  acquire(label: string): () => void {
    if (this.#active.size >= this.#limit) {
      throw new Error(
        `At most ${this.#limit.toString()} glass layers may be visible at once`,
      );
    }
    const token = Symbol(label);
    this.#active.add(token);
    return () => {
      this.#active.delete(token);
    };
  }
}

export const GlassLayerContext = createContext<GlassLayerBudget | null>(null);

export function useGlassLayer(active: boolean, label: string): void {
  const budget = useContext(GlassLayerContext);

  useEffect(() => {
    if (!active || !budget) return;
    try {
      return budget.acquire(label);
    } catch (cause) {
      if (import.meta.env.DEV) {
        console.warn(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }
  }, [active, budget, label]);
}
