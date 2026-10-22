import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  BCH_KEY_ROLES,
  EVM_KEY_ROLES,
  type BchKeyRole,
  type EvmKeyRole,
  type KeyRole,
  type RoleAddresses
} from './types.js';
import {
  generateBchTestnetWif,
  generateEvmPrivateKey,
  deriveBchAddressesFromWif,
  deriveEvmAddress
} from './derive.js';

/**
 * Resolve the path to .env.local in the main repository checkout.
 * Works from any git worktree or the main checkout itself.
 */
export function getDefaultEnvPath(): string {
  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return path.resolve(process.cwd(), gitCommonDir, '..', '.env.local');
  } catch {
    // Fallback if not inside a git tree
    return path.resolve(process.cwd(), '.env.local');
  }
}

/**
 * Parse an env file and return key-value pairs.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  }
  return env;
}

export interface GenerateKeysResult {
  envPath: string;
  generatedKeys: KeyRole[];
  skippedKeys: KeyRole[];
  addresses: RoleAddresses;
}

/**
 * Generate any missing keys and append them to .env.local.
 * Never overwrites existing keys.
 * Ensures file mode is 0o600.
 */
export function generateMissingKeys(envPath: string = getDefaultEnvPath()): GenerateKeysResult {
  const existingEnv = parseEnvFile(envPath);
  const generatedKeys: KeyRole[] = [];
  const skippedKeys: KeyRole[] = [];
  const newEntries: { key: string; value: string; comment?: string }[] = [];

  const addresses: RoleAddresses = {
    bch: {
      SOLVER_BCH_WIF: null,
      USER_BCH_WIF: null,
      USER2_BCH_WIF: null
    },
    evm: {
      DEPLOYER_EVM_PRIVATE_KEY: null,
      SOLVER_EVM_PRIVATE_KEY: null,
      USER_EVM_PRIVATE_KEY: null,
      USER2_EVM_PRIVATE_KEY: null
    }
  };

  // BCH Keys
  for (const role of BCH_KEY_ROLES) {
    if (existingEnv[role]) {
      skippedKeys.push(role);
      try {
        addresses.bch[role] = deriveBchAddressesFromWif(existingEnv[role]);
      } catch (err: any) {
        addresses.bch[role] = null;
      }
    } else {
      const wif = generateBchTestnetWif();
      generatedKeys.push(role);
      existingEnv[role] = wif;
      newEntries.push({ key: role, value: wif });
      addresses.bch[role] = deriveBchAddressesFromWif(wif);
    }
  }

  // EVM Keys
  for (const role of EVM_KEY_ROLES) {
    if (existingEnv[role]) {
      skippedKeys.push(role);
      try {
        addresses.evm[role] = deriveEvmAddress(existingEnv[role]);
      } catch {
        addresses.evm[role] = null;
      }
    } else {
      const privKey = generateEvmPrivateKey();
      generatedKeys.push(role);
      existingEnv[role] = privKey;
      newEntries.push({ key: role, value: privKey });
      addresses.evm[role] = deriveEvmAddress(privKey);
    }
  }

  if (newEntries.length > 0) {
    const fileExists = fs.existsSync(envPath);
    let appendText = '';
    if (!fileExists) {
      appendText += '# Ferry Lab — local secrets (never commit)\n';
      appendText += '# Mode 0600. Single source of testnet keys.\n\n';
    } else {
      const currentContent = fs.readFileSync(envPath, 'utf8');
      if (currentContent.length > 0 && !currentContent.endsWith('\n')) {
        appendText += '\n';
      }
    }

    for (const entry of newEntries) {
      appendText += `${entry.key}=${entry.value}\n`;
    }

    fs.appendFileSync(envPath, appendText, { mode: 0o600 });
  }

  // Ensure mode 600
  if (fs.existsSync(envPath)) {
    fs.chmodSync(envPath, 0o600);
  }

  return {
    envPath,
    generatedKeys,
    skippedKeys,
    addresses
  };
}

/**
 * Re-derive and return all role addresses from the given env file.
 */
export function getAddressesFromEnv(envPath: string = getDefaultEnvPath()): RoleAddresses {
  const env = parseEnvFile(envPath);
  const addresses: RoleAddresses = {
    bch: {
      SOLVER_BCH_WIF: null,
      USER_BCH_WIF: null,
      USER2_BCH_WIF: null
    },
    evm: {
      DEPLOYER_EVM_PRIVATE_KEY: null,
      SOLVER_EVM_PRIVATE_KEY: null,
      USER_EVM_PRIVATE_KEY: null,
      USER2_EVM_PRIVATE_KEY: null
    }
  };

  for (const role of BCH_KEY_ROLES) {
    if (env[role]) {
      try {
        addresses.bch[role] = deriveBchAddressesFromWif(env[role]);
      } catch {
        addresses.bch[role] = null;
      }
    }
  }

  for (const role of EVM_KEY_ROLES) {
    if (env[role]) {
      try {
        addresses.evm[role] = deriveEvmAddress(env[role]);
      } catch {
        addresses.evm[role] = null;
      }
    }
  }

  return addresses;
}

/**
 * Format derived addresses for console display.
 * Strictly outputs addresses only. Never displays secret values.
 */
export function formatAddressesOutput(addresses: RoleAddresses): string {
  const lines: string[] = [];
  lines.push('=== Bitcoin Cash Chipnet Roles ===');
  for (const role of BCH_KEY_ROLES) {
    const info = addresses.bch[role];
    lines.push(`  ${role}:`);
    if (info) {
      lines.push(`    P2PKH (plain):       ${info.plain}`);
      lines.push(`    P2PKH (token-aware): ${info.tokenAware}`);
    } else {
      lines.push(`    [Not configured in .env.local]`);
    }
  }

  lines.push('\n=== EVM Testnet Roles (Base Sepolia) ===');
  for (const role of EVM_KEY_ROLES) {
    const addr = addresses.evm[role];
    lines.push(`  ${role}:`);
    if (addr) {
      lines.push(`    Address:             ${addr}`);
    } else {
      lines.push(`    [Not configured in .env.local]`);
    }
  }

  return lines.join('\n');
}
