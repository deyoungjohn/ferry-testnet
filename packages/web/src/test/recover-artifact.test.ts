import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = existsSync(resolve(process.cwd(), 'scripts/build-recover.mjs'))
  ? process.cwd()
  : resolve(process.cwd(), 'packages/web');
const script = resolve(webRoot, 'scripts/build-recover.mjs');

describe('recover.html artifact', () => {
  it('matches a fresh standalone build', () => {
    expect(() =>
      execFileSync(process.execPath, [script, '--check'], {
        cwd: webRoot,
        stdio: 'pipe',
        timeout: 60_000,
      }),
    ).not.toThrow();
  });
});
