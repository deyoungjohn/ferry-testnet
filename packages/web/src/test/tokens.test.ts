import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcDir = join(
  existsSync(join(process.cwd(), 'src'))
    ? process.cwd()
    : join(process.cwd(), 'packages/web'),
  'src',
);
const HEX_COLOUR = /#[0-9a-fA-F]{3,8}\b/;

function collectTsx(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectTsx(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('design tokens', () => {
  it('keeps hard-coded hex colours out of components', () => {
    const offenders = collectTsx(srcDir)
      .filter((file) => HEX_COLOUR.test(readFileSync(file, 'utf8')))
      .map((file) => relative(srcDir, file));

    expect(offenders).toEqual([]);
  });
});
