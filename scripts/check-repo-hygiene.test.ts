import { describe, it, expect } from 'vitest';
import {
  checkTrackedPath,
  checkTrackedContent,
  runHygieneCheck,
} from './check-repo-hygiene.js';

describe('Repository Hygiene Path Checker', () => {
  it('allows benign repository files and .env.example', () => {
    expect(checkTrackedPath('.env.example')).toBeNull();
    expect(checkTrackedPath('packages/web/.env.example')).toBeNull();
    expect(checkTrackedPath('packages/core/src/index.ts')).toBeNull();
    expect(checkTrackedPath('README.md')).toBeNull();
    expect(checkTrackedPath('package.json')).toBeNull();
    expect(checkTrackedPath('lab/runbook-solver.md')).toBeNull();
  });

  it('detects and rejects .env and secret configuration files', () => {
    const envLocal = checkTrackedPath('.env.local');
    expect(envLocal).not.toBeNull();
    expect(envLocal?.rule).toBe('FORBIDDEN_FILE_PATH');

    const envProd = checkTrackedPath('packages/web/.env.production');
    expect(envProd).not.toBeNull();
    expect(envProd?.rule).toBe('FORBIDDEN_FILE_PATH');

    const envRoot = checkTrackedPath('.env');
    expect(envRoot).not.toBeNull();
  });

  it('detects and rejects raw key and WIF files', () => {
    expect(checkTrackedPath('keys/deployer.key')?.rule).toBe(
      'FORBIDDEN_FILE_PATH',
    );
    expect(checkTrackedPath('scripts/keys/solver.wif')?.rule).toBe(
      'FORBIDDEN_FILE_PATH',
    );
    expect(checkTrackedPath('cert.pem')?.rule).toBe('FORBIDDEN_FILE_PATH');
    expect(checkTrackedPath('private.pkcs8')?.rule).toBe('FORBIDDEN_FILE_PATH');
  });

  it('detects and rejects Solana keypair JSON files', () => {
    expect(checkTrackedPath('packages/htlc-solana/id.json')?.rule).toBe(
      'FORBIDDEN_FILE_PATH',
    );
    expect(
      checkTrackedPath('packages/htlc-solana/ferry-keypair.json')?.rule,
    ).toBe('FORBIDDEN_FILE_PATH');
    expect(checkTrackedPath('keypair-solana.json')?.rule).toBe(
      'FORBIDDEN_FILE_PATH',
    );
  });

  it('detects and rejects SQLite database and WAL/SHM runtime state', () => {
    expect(checkTrackedPath('packages/solver/data/solver.db')?.rule).toBe(
      'FORBIDDEN_FILE_PATH',
    );
    expect(checkTrackedPath('packages/solver/data/solver.db-wal')?.rule).toBe(
      'FORBIDDEN_FILE_PATH',
    );
    expect(checkTrackedPath('packages/solver/data/solver.db-shm')?.rule).toBe(
      'FORBIDDEN_FILE_PATH',
    );
    expect(checkTrackedPath('data/state.sqlite')?.rule).toBe(
      'FORBIDDEN_FILE_PATH',
    );
    expect(checkTrackedPath('packages/solver/data/archive/old.db')?.rule).toBe(
      'FORBIDDEN_FILE_PATH',
    );
  });

  it('detects and rejects Foundry broadcast logs and Anchor deploy targets', () => {
    expect(
      checkTrackedPath(
        'packages/htlc-evm/broadcast/Deploy.s.sol/1/run-latest.json',
      )?.rule,
    ).toBe('FORBIDDEN_FILE_PATH');
    expect(
      checkTrackedPath('packages/htlc-evm/cache/solidity-files-cache.json')
        ?.rule,
    ).toBe('FORBIDDEN_FILE_PATH');
    expect(
      checkTrackedPath('packages/htlc-solana/target/deploy/ferry_htlc.so')
        ?.rule,
    ).toBe('FORBIDDEN_FILE_PATH');
  });
});

describe('Repository Hygiene Content Checker', () => {
  it('permits known benign test/mock key prefixes in source', () => {
    const anvilCode = `const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";`;
    const violations = checkTrackedContent('src/dev-helper.ts', anvilCode);
    expect(violations).toHaveLength(0);
  });

  it('flags suspected raw private key assignments in source code without printing values', () => {
    // Generate a random-looking 64 hex private key assignment
    const badCode = `export const USER_PRIVATE_KEY = "4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b";`;
    const violations = checkTrackedContent(
      'packages/core/src/secret.ts',
      badCode,
    );

    expect(violations).toHaveLength(1);
    const first = violations[0]!;
    expect(first.rule).toBe('SUSPECTED_PRIVATE_KEY');
    // Ensure the message does not reveal the secret value
    expect(first.message).not.toContain('4a5b6c7d8e9f0a1b');
    expect(first.line).toBe(1);
  });

  it('flags suspected Solana keypair byte arrays in source files', () => {
    const bytes = Array(64).fill(42).join(', ');
    const badCode = `const secretKey = [${bytes}];`;
    const violations = checkTrackedContent(
      'packages/chain-solana/src/signer.ts',
      badCode,
    );

    expect(violations).toHaveLength(1);
    const first = violations[0]!;
    expect(first.rule).toBe('SUSPECTED_SOLANA_KEYPAIR');
    expect(first.message).not.toContain('42, 42');
  });

  it('does not flag shorter numeric arrays from generated bundles', () => {
    const bytes = Array(32).fill(255).join(', ');
    expect(
      checkTrackedContent('recover.html', `const mask = [${bytes}];`),
    ).toHaveLength(0);
  });

  it('ignores test files and markdown documentation from content flagging', () => {
    const testCode = `const PRIVATE_KEY = "4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b";`;
    expect(
      checkTrackedContent('packages/core/test/key.test.ts', testCode),
    ).toHaveLength(0);
    expect(
      checkTrackedContent('lab/chain-notes/base.md', testCode),
    ).toHaveLength(0);
    expect(checkTrackedContent('test/fixture.json', testCode)).toHaveLength(0);
  });
});

describe('Live Repository Hygiene Verification', () => {
  it('confirms the active repository working tree is 100% clean of forbidden files and credentials', () => {
    const violations = runHygieneCheck();
    expect(violations).toEqual([]);
  });
});
