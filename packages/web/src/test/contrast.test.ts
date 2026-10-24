import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = existsSync(join(process.cwd(), 'src/styles/tokens.css'))
  ? process.cwd()
  : join(process.cwd(), 'packages/web');
const tokensCss = readFileSync(
  join(packageRoot, 'src/styles/tokens.css'),
  'utf8',
);

function token(name: string): string {
  const match = tokensCss.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) {
    throw new Error(`Token --${name} is missing or is not a hex colour`);
  }
  return match[1];
}

function channel(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.slice(1);
  const red = Number.parseInt(value.slice(0, 2), 16) / 255;
  const green = Number.parseInt(value.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(value.slice(4, 6), 16) / 255;
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  );
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

const PAIRS = [
  ['text', 'bg'],
  ['text', 'surface-1'],
  ['text', 'surface-2'],
  ['text', 'surface-3'],
  ['text-muted', 'bg'],
  ['text-muted', 'surface-1'],
  ['text-muted', 'surface-2'],
  ['text-muted', 'surface-3'],
  ['text-muted', 'olive-soft'],
  ['lime', 'bg'],
  ['lime', 'olive-soft'],
  ['lime-ink', 'lime'],
  ['text', 'olive'],
  ['bg', 'text'],
] as const;

describe.each(PAIRS)('token contrast: %s on %s', (foreground, background) => {
  it('meets WCAG AA for body text (4.5:1)', () => {
    expect(
      contrast(token(foreground), token(background)),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
