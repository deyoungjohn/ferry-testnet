import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts/build-recover.mjs');

describe('recover.html artifact', () => {
  it('matches a fresh standalone build', () => {
    expect(() =>
      execFileSync(process.execPath, [script, '--check'], {
        cwd: process.cwd(),
        stdio: 'pipe',
        timeout: 60_000,
      }),
    ).not.toThrow();
  });
});
