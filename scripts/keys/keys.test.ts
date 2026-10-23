import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hexToBin } from '@bitauth/libauth';
import {
  deriveBchAddressesFromPkh,
  deriveBchAddressesFromWif,
  deriveEvmAddress,
  isValidBchWif,
  isValidEvmPrivateKey,
} from './derive.js';
import {
  generateMissingKeys,
  getAddressesFromEnv,
  parseEnvFile,
  formatAddressesOutput,
} from './env.js';
import { BCH_KEY_ROLES, EVM_KEY_ROLES } from './types.js';

describe('Key Derivation Vectors & Provenance', () => {
  it('correctly derives BCH plain and token-aware addresses from known Libauth test vector', () => {
    // Provenance:
    // File: docs/addresses.md in @bitauth/libauth repo
    // Section: "CashAddress Examples" / encodeCashAddress
    // URL: https://github.com/bitauth/libauth/blob/master/docs/addresses.md
    // PKH: 15d16c84669ab46059313bf0747e781f1d13936d
    const knownPkh = hexToBin('15d16c84669ab46059313bf0747e781f1d13936d');
    const result = deriveBchAddressesFromPkh(knownPkh, 'bchtest');

    expect(result.plain).toBe(
      'bchtest:qq2azmyyv6dtgczexyalqar70q036yund53jvfde0x',
    );
    expect(result.tokenAware).toBe(
      'bchtest:zq2azmyyv6dtgczexyalqar70q036yund5kclhrls4',
    );
  });

  it('correctly derives mainnet BCH address from Libauth docs keys.md WIF vector', () => {
    // Provenance:
    // File: docs/keys.md in @bitauth/libauth repo
    // Section: "Wallet Import Format (WIF)" -> decodePrivateKeyWif example
    // URL: https://github.com/bitauth/libauth/blob/master/docs/keys.md
    // WIF: L1RrrnXkcKut5DEMwtDthjwRcTTwED36thyL1DebVrKuwvohjMNi
    const knownWif = 'L1RrrnXkcKut5DEMwtDthjwRcTTwED36thyL1DebVrKuwvohjMNi';
    const result = deriveBchAddressesFromWif(knownWif, 'bitcoincash');

    expect(result.plain).toBe(
      'bitcoincash:qrfdnw009wga3yg5ann9v930s8upw2h33s9ahmklw6',
    );
    expect(result.tokenAware).toBe(
      'bitcoincash:zrfdnw009wga3yg5ann9v930s8upw2h33szhy9ce3f',
    );
  });

  it('correctly derives BCH addresses from standard testnet WIF vector (key 1)', () => {
    // Provenance:
    // Bitcoin Wiki / BIP-38 test vectors: secp256k1 private key = 1 (compressed testnet WIF)
    // URL: https://en.bitcoin.it/wiki/Wallet_import_format
    const knownTestnetWif =
      'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA';
    const result = deriveBchAddressesFromWif(knownTestnetWif, 'bchtest');

    expect(result.plain).toBe(
      'bchtest:qp63uahgrxged4z5jswyt5dn5v3lzsem6cq85x00dt',
    );
    expect(result.tokenAware).toBe(
      'bchtest:zp63uahgrxged4z5jswyt5dn5v3lzsem6c8d8cpfjc',
    );
  });

  it('correctly derives checksummed EVM address from known private key vector', () => {
    // Standard EVM test vector: private key 1 (0x00...01)
    const privKey =
      '0x0000000000000000000000000000000000000000000000000000000000000001';
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

    expect(res.generatedKeys.length).toBe(
      BCH_KEY_ROLES.length + EVM_KEY_ROLES.length,
    );
    expect(res.skippedKeys.length).toBe(0);
    expect(fs.existsSync(tempEnvPath)).toBe(true);

    const stat = fs.statSync(tempEnvPath);
    // Mode should be 0o600 (-rw-------)
    expect(stat.mode & 0o777).toBe(0o600);

    const parsed = parseEnvFile(tempEnvPath);
    for (const role of BCH_KEY_ROLES) {
      const val = parsed[role];
      expect(val).toBeDefined();
      expect(val?.startsWith('c')).toBe(true); // Testnet WIF prefix
    }
    for (const role of EVM_KEY_ROLES) {
      const val = parsed[role];
      expect(val).toBeDefined();
      expect(val?.startsWith('0x')).toBe(true);
      expect(val?.length).toBe(66);
    }
  });

  it('never overwrites existing keys on subsequent runs', () => {
    // First run
    generateMissingKeys(tempEnvPath);
    const initialContent = fs.readFileSync(tempEnvPath, 'utf8');
    const parsed1 = parseEnvFile(tempEnvPath);

    // Second run
    const res2 = generateMissingKeys(tempEnvPath);
    const secondContent = fs.readFileSync(tempEnvPath, 'utf8');
    const parsed2 = parseEnvFile(tempEnvPath);

    expect(res2.generatedKeys.length).toBe(0);
    expect(res2.skippedKeys.length).toBe(
      BCH_KEY_ROLES.length + EVM_KEY_ROLES.length,
    );
    expect(secondContent).toBe(initialContent);

    for (const key of Object.keys(parsed1)) {
      expect(parsed2[key]).toBe(parsed1[key]);
    }
  });

  it('fills empty values in place without creating duplicate lines', () => {
    // Simulating copying .env.example with empty values
    const initialEnv = [
      '# Top comment',
      'USER_BCH_WIF=',
      'SOLVER_BCH_WIF=cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA',
      'DEPLOYER_EVM_PRIVATE_KEY=""',
      '# Bottom comment',
    ].join('\n');

    fs.writeFileSync(tempEnvPath, initialEnv, { mode: 0o600 });

    const res = generateMissingKeys(tempEnvPath);
    expect(res.skippedKeys).toContain('SOLVER_BCH_WIF');
    expect(res.generatedKeys).toContain('USER_BCH_WIF');
    expect(res.generatedKeys).toContain('DEPLOYER_EVM_PRIVATE_KEY');

    const updatedContent = fs.readFileSync(tempEnvPath, 'utf8');
    const lines = updatedContent.split('\n');

    // Count occurrences of USER_BCH_WIF=
    const userBchLines = lines.filter((l) => l.startsWith('USER_BCH_WIF='));
    expect(userBchLines.length).toBe(1);
    expect(userBchLines[0]!).not.toBe('USER_BCH_WIF=');
    expect(isValidBchWif(userBchLines[0]!.replace('USER_BCH_WIF=', ''))).toBe(
      true,
    );

    // Check SOLVER_BCH_WIF was kept untouched
    const solverLines = lines.filter((l) => l.startsWith('SOLVER_BCH_WIF='));
    expect(solverLines.length).toBe(1);
    expect(solverLines[0]).toBe(
      'SOLVER_BCH_WIF=cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA',
    );

    // Check DEPLOYER_EVM_PRIVATE_KEY was filled in place
    const deployerLines = lines.filter((l) =>
      l.startsWith('DEPLOYER_EVM_PRIVATE_KEY='),
    );
    expect(deployerLines.length).toBe(1);
    expect(
      isValidEvmPrivateKey(
        deployerLines[0]!.replace('DEPLOYER_EVM_PRIVATE_KEY=', ''),
      ),
    ).toBe(true);
  });

  it('marks invalid keys as INVALID in addresses output and never echoes invalid secrets', () => {
    const invalidSecretBch = 'not_a_valid_bch_wif_123456';
    const invalidSecretEvm = '0x1234invaliddeadbeef';

    const envWithInvalid = [
      `USER_BCH_WIF=${invalidSecretBch}`,
      `SOLVER_EVM_PRIVATE_KEY=${invalidSecretEvm}`,
    ].join('\n');

    fs.writeFileSync(tempEnvPath, envWithInvalid, { mode: 0o600 });

    const res = generateMissingKeys(tempEnvPath);
    expect(res.hasInvalidKeys).toBe(true);
    expect(res.invalidKeys).toContain('USER_BCH_WIF');
    expect(res.invalidKeys).toContain('SOLVER_EVM_PRIVATE_KEY');
    expect(res.addresses.bch.USER_BCH_WIF).toBe('INVALID');
    expect(res.addresses.evm.SOLVER_EVM_PRIVATE_KEY).toBe('INVALID');

    const formatted = formatAddressesOutput(res.addresses);
    expect(formatted).toContain(
      'USER_BCH_WIF:\n    P2PKH (plain):       INVALID',
    );
    expect(formatted).toContain(
      'SOLVER_EVM_PRIVATE_KEY:\n    Address:             INVALID',
    );

    // CRITICAL: Ensure neither invalid secret is echoed in the output
    expect(formatted).not.toContain(invalidSecretBch);
    expect(formatted).not.toContain(invalidSecretEvm);

    // Also test getAddressesFromEnv
    const checkRes = getAddressesFromEnv(tempEnvPath);
    expect(checkRes.hasInvalidKeys).toBe(true);
    expect(checkRes.invalidKeys).toContain('USER_BCH_WIF');
    expect(checkRes.invalidKeys).toContain('SOLVER_EVM_PRIVATE_KEY');
  });

  it('formatted output contains only public addresses and never private keys or WIFs', () => {
    const res = generateMissingKeys(tempEnvPath);
    const parsed = parseEnvFile(tempEnvPath);
    const output = formatAddressesOutput(res.addresses);

    // Verify all addresses are in output
    for (const role of BCH_KEY_ROLES) {
      const addr = res.addresses.bch[role];
      expect(addr).toBeDefined();
      expect(addr).not.toBe('INVALID');
      if (typeof addr === 'object' && addr !== null) {
        expect(output).toContain(addr.plain);
        expect(output).toContain(addr.tokenAware);
      }
    }
    for (const role of EVM_KEY_ROLES) {
      const addr = res.addresses.evm[role];
      expect(addr).toBeDefined();
      expect(addr).not.toBe('INVALID');
      if (typeof addr === 'string') {
        expect(output).toContain(addr);
      }
    }

    // Verify NO secret material is in output
    for (const role of [...BCH_KEY_ROLES, ...EVM_KEY_ROLES]) {
      const secret = parsed[role];
      expect(secret).toBeDefined();
      if (secret) {
        expect(output).not.toContain(secret);
      }
    }
  });
});
