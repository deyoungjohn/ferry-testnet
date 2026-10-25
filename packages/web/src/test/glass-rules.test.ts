import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GlassLayerBudget, MAX_GLASS_LAYERS } from '../lib/glass-layer';

const packageRoot = existsSync(join(process.cwd(), 'src/styles/glass.css'))
  ? process.cwd()
  : join(process.cwd(), 'packages/web');
const glassCss = readFileSync(
  join(packageRoot, 'src/styles/glass.css'),
  'utf8',
);

describe('glass engineering rules', () => {
  it('never animates the blur radius', () => {
    expect(glassCss).not.toMatch(/transition[^;{}]*blur/i);
    expect(glassCss).not.toMatch(/animation[^;{}]*blur/i);
    expect(glassCss).not.toMatch(/@keyframes[^{]*blur/i);
  });

  it('uses will-change only while a glass surface is animating', () => {
    const declarations = [...glassCss.matchAll(/will-change:\s*([^;]+);/g)];
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.[1]?.trim()).toBe('transform');
    expect(glassCss).toContain(".glass-motion[data-animating='true']");
    expect(glassCss).not.toMatch(/\.glass\s*\{[^}]*will-change/s);
  });

  it('uses the light scrim from the blueprint', () => {
    expect(glassCss).toContain('background: rgba(0, 0, 0, 0.25)');
  });

  it('has reduced-transparency and no-backdrop-filter fallbacks', () => {
    expect(glassCss).toContain('prefers-reduced-transparency: reduce');
    expect(glassCss).toContain('prefers-reduced-motion: reduce');
    expect(glassCss).toContain('[data-vaul-drawer]');
    expect(glassCss).toContain('@supports not');
    expect(glassCss).toContain('background: var(--surface-3)');
  });

  it('ships the displacement map next to the lens filter', () => {
    expect(
      existsSync(join(packageRoot, 'public/glass/rim-displacement.png')),
    ).toBe(true);
  });
});

describe('glass layer budget', () => {
  it(`allows at most ${MAX_GLASS_LAYERS.toString()} visible glass layers`, () => {
    const budget = new GlassLayerBudget();
    const releaseSheet = budget.acquire('sheet');
    const releaseSecondSheet = budget.acquire('sheet');

    expect(budget.activeCount).toBe(2);
    expect(() => budget.acquire('popover')).toThrow(
      'At most 2 glass layers may be visible at once',
    );

    releaseSecondSheet();
    const releasePopover = budget.acquire('popover');
    expect(budget.activeCount).toBe(2);
    releasePopover();
    releaseSheet();
    expect(budget.activeCount).toBe(0);
  });
});
