import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  BCH_KEY_ROLES,
  EVM_KEY_ROLES,
  SOL_KEY_ROLES,
  type KeyRole,
  type RoleAddresses,
} from './types.js';
import {
  generateBchTestnetWif,
  generateEvmPrivateKey,
  generateSolanaKeypair,
  deriveBchAddressesFromWif,
  deriveEvmAddress,
  deriveSolanaAddress,
  isValidBchWif,
  isValidEvmPrivateKey,
  isValidSolanaKeypair,
} from './derive.js';
import bs58 from 'bs58';

/**
 * Resolve the path to .env.local in the main repository checkout.
 * Works from any git worktree or the main checkout itself.
 */
export function getDefaultEnvPath(): string {
  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
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
  invalidKeys: KeyRole[];
  addresses: RoleAddresses;
  hasInvalidKeys: boolean;
}

/**
 * Generate any missing keys and append them to .env.local, or fill in-place
 * if a key exists with an empty value.
 * Never overwrites non-empty existing keys.
 * Ensures file mode is 0o600.
 */
export function generateMissingKeys(
  envPath: string = getDefaultEnvPath(),
): GenerateKeysResult {
  const fileExists = fs.existsSync(envPath);
  let fileContent = fileExists ? fs.readFileSync(envPath, 'utf8') : '';

  const parsedEnv = parseEnvFile(envPath);
  const generatedKeys: KeyRole[] = [];
  const skippedKeys: KeyRole[] = [];
  const invalidKeys: KeyRole[] = [];

  const addresses: RoleAddresses = {
    bch: {
      SOLVER_BCH_WIF: null,
      USER_BCH_WIF: null,
      USER2_BCH_WIF: null,
    },
    evm: {
      DEPLOYER_EVM_PRIVATE_KEY: null,
      SOLVER_EVM_PRIVATE_KEY: null,
      USER_EVM_PRIVATE_KEY: null,
      USER2_EVM_PRIVATE_KEY: null,
    },
    sol: {
      DEPLOYER_SOL_KEYPAIR: null,
      SOLVER_SOL_KEYPAIR: null,
      USER_SOL_KEYPAIR: null,
    },
  };

  const keysToFillInPlace = new Map<string, string>();
  const keysToAppend: { key: string; value: string }[] = [];

  // 1. Process BCH roles
  for (const role of BCH_KEY_ROLES) {
    const rawVal = parsedEnv[role];
    if (rawVal !== undefined && rawVal !== '') {
      // Key is present with a non-empty value
      skippedKeys.push(role);
      if (isValidBchWif(rawVal)) {
        addresses.bch[role] = deriveBchAddressesFromWif(rawVal);
      } else {
        addresses.bch[role] = 'INVALID';
        invalidKeys.push(role);
      }
    } else {
      // Key is missing entirely OR present with empty value
      const newWif = generateBchTestnetWif();
      generatedKeys.push(role);
      addresses.bch[role] = deriveBchAddressesFromWif(newWif);
      if (rawVal === '') {
        keysToFillInPlace.set(role, newWif);
      } else {
        keysToAppend.push({ key: role, value: newWif });
      }
    }
  }

  // 2. Process EVM roles
  for (const role of EVM_KEY_ROLES) {
    const rawVal = parsedEnv[role];
    if (rawVal !== undefined && rawVal !== '') {
      // Key is present with a non-empty value
      skippedKeys.push(role);
      if (isValidEvmPrivateKey(rawVal)) {
        addresses.evm[role] = deriveEvmAddress(rawVal);
      } else {
        addresses.evm[role] = 'INVALID';
        invalidKeys.push(role);
      }
    } else {
      // Key is missing entirely OR present with empty value
      const newPrivKey = generateEvmPrivateKey();
      generatedKeys.push(role);
      addresses.evm[role] = deriveEvmAddress(newPrivKey);
      if (rawVal === '') {
        keysToFillInPlace.set(role, newPrivKey);
      } else {
        keysToAppend.push({ key: role, value: newPrivKey });
      }
    }
  }

  // 3. Process Solana roles
  for (const role of SOL_KEY_ROLES) {
    const rawVal = parsedEnv[role];
    if (rawVal !== undefined && rawVal !== '') {
      skippedKeys.push(role);
      if (isValidSolanaKeypair(rawVal)) {
        addresses.sol[role] = deriveSolanaAddress(rawVal);
      } else {
        addresses.sol[role] = 'INVALID';
        invalidKeys.push(role);
      }
    } else {
      let newKey: string;
      const deployerFile = '/home/user/.config/solana/devnet-deployer.json';
      if (role === 'DEPLOYER_SOL_KEYPAIR' && fs.existsSync(deployerFile)) {
        try {
          const raw = JSON.parse(fs.readFileSync(deployerFile, 'utf8'));
          newKey = bs58.encode(Uint8Array.from(raw));
        } catch {
          newKey = generateSolanaKeypair();
        }
      } else {
        newKey = generateSolanaKeypair();
      }
      generatedKeys.push(role);
      addresses.sol[role] = deriveSolanaAddress(newKey);
      if (rawVal === '') {
        keysToFillInPlace.set(role, newKey);
      } else {
        keysToAppend.push({ key: role, value: newKey });
      }
    }
  }

  // If we need to write changes
  if (keysToFillInPlace.size > 0 || keysToAppend.length > 0) {
    if (!fileExists) {
      fileContent =
        '# Ferry Lab — local secrets (never commit)\n# Mode 0600. Single source of testnet keys.\n\n';
    }

    // Replace empty values in place
    if (keysToFillInPlace.size > 0) {
      const lines = fileContent.split('\n');
      const updatedLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const eqIdx = line.indexOf('=');
        if (eqIdx !== -1) {
          const key = line.slice(0, eqIdx).trim();
          if (keysToFillInPlace.has(key)) {
            const val = keysToFillInPlace.get(key)!;
            return `${key}=${val}`;
          }
        }
        return line;
      });
      fileContent = updatedLines.join('\n');
    }

    // Append new keys that were completely missing
    if (keysToAppend.length > 0) {
      if (fileContent.length > 0 && !fileContent.endsWith('\n')) {
        fileContent += '\n';
      }
      for (const entry of keysToAppend) {
        fileContent += `${entry.key}=${entry.value}\n`;
      }
    }

    fs.writeFileSync(envPath, fileContent, { mode: 0o600 });
  }

  // Ensure mode 600
  if (fs.existsSync(envPath)) {
    fs.chmodSync(envPath, 0o600);
  }

  return {
    envPath,
    generatedKeys,
    skippedKeys,
    invalidKeys,
    addresses,
    hasInvalidKeys: invalidKeys.length > 0,
  };
}

export interface GetAddressesResult {
  addresses: RoleAddresses;
  hasInvalidKeys: boolean;
  invalidKeys: KeyRole[];
}

/**
 * Re-derive and return all role addresses from the given env file.
 */
export function getAddressesFromEnv(
  envPath: string = getDefaultEnvPath(),
): GetAddressesResult {
  const env = parseEnvFile(envPath);
  const invalidKeys: KeyRole[] = [];

  const addresses: RoleAddresses = {
    bch: {
      SOLVER_BCH_WIF: null,
      USER_BCH_WIF: null,
      USER2_BCH_WIF: null,
    },
    evm: {
      DEPLOYER_EVM_PRIVATE_KEY: null,
      SOLVER_EVM_PRIVATE_KEY: null,
      USER_EVM_PRIVATE_KEY: null,
      USER2_EVM_PRIVATE_KEY: null,
    },
    sol: {
      DEPLOYER_SOL_KEYPAIR: null,
      SOLVER_SOL_KEYPAIR: null,
      USER_SOL_KEYPAIR: null,
    },
  };

  for (const role of BCH_KEY_ROLES) {
    const val = env[role];
    if (val !== undefined && val !== '') {
      if (isValidBchWif(val)) {
        addresses.bch[role] = deriveBchAddressesFromWif(val);
      } else {
        addresses.bch[role] = 'INVALID';
        invalidKeys.push(role);
      }
    }
  }

  for (const role of EVM_KEY_ROLES) {
    const val = env[role];
    if (val !== undefined && val !== '') {
      if (isValidEvmPrivateKey(val)) {
        addresses.evm[role] = deriveEvmAddress(val);
      } else {
        addresses.evm[role] = 'INVALID';
        invalidKeys.push(role);
      }
    }
  }

  for (const role of SOL_KEY_ROLES) {
    const val = env[role];
    if (val !== undefined && val !== '') {
      if (isValidSolanaKeypair(val)) {
        addresses.sol[role] = deriveSolanaAddress(val);
      } else {
        addresses.sol[role] = 'INVALID';
        invalidKeys.push(role);
      }
    }
  }

  return {
    addresses,
    hasInvalidKeys: invalidKeys.length > 0,
    invalidKeys,
  };
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
    if (info === 'INVALID') {
      lines.push('    P2PKH (plain):       INVALID');
      lines.push('    P2PKH (token-aware): INVALID');
    } else if (info) {
      lines.push(`    P2PKH (plain):       ${info.plain}`);
      lines.push(`    P2PKH (token-aware): ${info.tokenAware}`);
    } else {
      lines.push('    [Not configured in .env.local]');
    }
  }

  lines.push('\n=== EVM Testnet Roles (Base Sepolia) ===');
  for (const role of EVM_KEY_ROLES) {
    const addr = addresses.evm[role];
    lines.push(`  ${role}:`);
    if (addr === 'INVALID') {
      lines.push('    Address:             INVALID');
    } else if (addr) {
      lines.push(`    Address:             ${addr}`);
    } else {
      lines.push('    [Not configured in .env.local]');
    }
  }

  lines.push('\n=== Solana Devnet Roles ===');
  for (const role of SOL_KEY_ROLES) {
    const addr = addresses.sol[role];
    lines.push(`  ${role}:`);
    if (addr === 'INVALID') {
      lines.push('    Address:             INVALID');
    } else if (addr) {
      lines.push(`    Address:             ${addr}`);
    } else {
      lines.push('    [Not configured in .env.local]');
    }
  }

  return lines.join('\n');
}
