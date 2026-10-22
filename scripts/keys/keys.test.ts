import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hexToBin } from '@bitauth/libauth';
import {
  deriveBchAddressesFromPkh,
  deriveBchAddressesFromWif,
  deriveEvmAddress
} from './derive.js';
import {
  generateMissingKeys,
  parseEnvFile,
  formatAddressesOutput
} from './env.js';
import { BCH_KEY_ROLES, EVM_KEY_ROLES } from './types.js';

describe('Key Derivation Vectors', () => {
  it('correctly derives BCH plain and token-aware addresses from known Libauth test vector', () => {
    // Vector cited from @bitauth/libauth official docs/addresses.md
    // PKH: 15d16c84669ab46059313bf0747e781f1d13936d
    const knownPkh = hexToBin('15d16c84669ab46059313bf0747e781f1d13936d');
    const result = deriveBchAddressesFromPkh(knownPkh, 'bchtest');

    expect(result.plain).toBe('bchtest:qq2azmyyv6dtgczexyalqar70q036yund53jvfde0x');
    expect(result.tokenAware).toBe('bchtest:zq2azmyyv6dtgczexyalqar70q036yund5kclhrls4');
  });

  it('correctly derives BCH addresses from known testnet WIF vector', () => {
    // Standard testnet WIF for private key 1 (compressed)
    const knownTestnetWif = 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA';
    const result = deriveBchAddressesFromWif(knownTestnetWif, 'bchtest');

    expect(result.plain).toBe('bchtest:qp63uahgrxged4z5jswyt5dn5v3lzsem6cq85x00dt');
    expect(result.tokenAware).toBe('bchtest:zp63uahgrxged4z5jswyt5dn5v3lzsem6c8d8cpfjc');
  });

  it('correctly derives checksummed EVM address from known private key vector', () => {
    // Known EVM test vector: private key 1
    const privKey = '0x0000000000000000000000000000000000000000000000000000000000000001';
    const address = deriveEvmAddress(privKey);
    expect(address).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  });
});

describe('Key Generation & Storage Safety', () => {
  let tempDir: string;
  let tempEnvPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-keys-test-'));
    tempEnvPath = path.join(tempDir, '.env.test');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('creates env file with mode 600 and generates all required roles', () => {
    const res = generateMissingKeys(tempEnvPath);

    expect(res.generatedKeys.length).toBe(BCH_KEY_ROLES.length + EVM_KEY_ROLES.length);
    expect(res.skippedKeys.length).toBe(0);
    expect(fs.existsSync(tempEnvPath)).toBe(true);

    const stat = fs.statSync(tempEnvPath);
    // Mode should be 0o600 (-rw-------)
    expect(stat.mode & 0o777).toBe(0o600);

    const parsed = parseEnvFile(tempEnvPath);
    for (const role of BCH_KEY_ROLES) {
      expect(parsed[role]).toBeDefined();
      expect(parsed[role].startsWith('c')).toBe(true); // Testnet WIF prefix
    }
    for (const role of EVM_KEY_ROLES) {
      expect(parsed[role]).toBeDefined();
      expect(parsed[role].startsWith('0x')).toBe(true);
      expect(parsed[role].length).toBe(66);
    }
  });

  it('never overwrites existing keys on subsequent runs', () => {
    // First run
    const res1 = generateMissingKeys(tempEnvPath);
    const initialContent = fs.readFileSync(tempEnvPath, 'utf8');
    const parsed1 = parseEnvFile(tempEnvPath);

    // Second run
    const res2 = generateMissingKeys(tempEnvPath);
    const secondContent = fs.readFileSync(tempEnvPath, 'utf8');
    const parsed2 = parseEnvFile(tempEnvPath);

    expect(res2.generatedKeys.length).toBe(0);
    expect(res2.skippedKeys.length).toBe(BCH_KEY_ROLES.length + EVM_KEY_ROLES.length);
    expect(secondContent).toBe(initialContent);

    for (const key of Object.keys(parsed1)) {
      expect(parsed2[key]).toBe(parsed1[key]);
    }
  });

  it('appends only missing keys and preserves existing keys', () => {
    // Pre-populate one key
    const customWif = 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA';
    fs.writeFileSync(tempEnvPath, `SOLVER_BCH_WIF=${customWif}\n`, { mode: 0o600 });

    const res = generateMissingKeys(tempEnvPath);
    expect(res.skippedKeys).toContain('SOLVER_BCH_WIF');
    expect(res.generatedKeys).not.toContain('SOLVER_BCH_WIF');

    const parsed = parseEnvFile(tempEnvPath);
    expect(parsed.SOLVER_BCH_WIF).toBe(customWif);
    expect(parsed.USER_BCH_WIF).toBeDefined();
    expect(parsed.DEPLOYER_EVM_PRIVATE_KEY).toBeDefined();
  });

  it('formatted output contains only public addresses and never private keys or WIFs', () => {
    const res = generateMissingKeys(tempEnvPath);
    const parsed = parseEnvFile(tempEnvPath);
    const output = formatAddressesOutput(res.addresses);

    // Verify all addresses are in output
    for (const role of BCH_KEY_ROLES) {
      expect(output).toContain(res.addresses.bch[role]!.plain);
      expect(output).toContain(res.addresses.bch[role]!.tokenAware);
    }
    for (const role of EVM_KEY_ROLES) {
      expect(output).toContain(res.addresses.evm[role]!);
    }

    // Verify NO secret material is in output
    for (const role of [...BCH_KEY_ROLES, ...EVM_KEY_ROLES]) {
      const secret = parsed[role];
      expect(secret).toBeDefined();
      expect(output).not.toContain(secret);
    }
  });
});
