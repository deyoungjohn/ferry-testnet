import { describe, expect, it } from 'vitest';
import { publicViteEnv } from '../../env/public-env';

describe('web environment bridge', () => {
  it('merges root env first and web env last', () => {
    expect(
      publicViteEnv(
        { VITE_REOWN_PROJECT_ID: 'root', VITE_SOLVER_URL: 'root-solver' },
        { VITE_SOLVER_URL: 'web-solver' },
      ),
    ).toEqual({
      VITE_REOWN_PROJECT_ID: 'root',
      VITE_SOLVER_URL: 'web-solver',
    });
  });

  it('never exposes private keys or non-VITE variables', () => {
    const env = publicViteEnv({
      VITE_REOWN_PROJECT_ID: 'public',
      USER_EVM_PRIVATE_KEY: '0xsecret',
      SOLVER_BCH_WIF: 'wif-secret',
      BCH_CHIPNET_ELECTRUM_URLS: 'wss://private',
    });

    expect(env).toEqual({ VITE_REOWN_PROJECT_ID: 'public' });
    expect(JSON.stringify(env)).not.toContain('secret');
  });
});
