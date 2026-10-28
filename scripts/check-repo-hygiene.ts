import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Known benign fixture prefixes (used in tests and local dev harnesses)
export const KNOWN_SAFE_KEY_PREFIXES = [
  'ac0974bec39a17e36ba4a6b4d238ff94', // Anvil account 0
  '59c6995e998f97a5a0044966f0945389', // Anvil account 1
  '5de4111afa1a4b94908f83103eb1f170', // Anvil account 2
  '7c852118294e51e653712a9905f110d7', // Anvil account 3
  '47e179ec3454c788e1dd0e0f01330b49', // Anvil account 4
  '8b3a350cf5c34c9194ca85829a2df0ec', // Anvil account 5
  '92db14e403b83dfe3df233f83dfa3a0d', // Anvil account 6
  '4bbbf8562e6315259d87632494916674', // Anvil account 7
  'dbda1821b80551c9d659393292502986', // Anvil account 8
  '2a871d0798f97d79848a013d4936a73b', // Anvil account 9
  'cPJEAQ', // Mock chipnet WIF fixture
  'L1Rrrn', // Libauth docs test WIF fixture
  'cMahea', // Libauth testnet WIF fixture
  'deadbeef',
  '11111111111111111111111111111111',
  '00000000000000000000000000000000',
];

export const FORBIDDEN_FILE_PATTERNS: Array<{
  pattern: RegExp;
  description: string;
}> = [
  {
    pattern: /(^|\/)\.env(\.[^/]+)?$/,
    description:
      'Environment file containing potential secrets (only .env.example allowed)',
  },
  {
    pattern: /\.(key|wif|pem|pkcs8|p12|pfx|der)$/i,
    description: 'Private key certificate or raw key file',
  },
  {
    pattern: /(^|\/)(keypair.*|.*-keypair|id)\.json$/i,
    description: 'Solana or raw cryptographic keypair JSON file',
  },
  {
    pattern: /\.(db|db-wal|db-shm|sqlite|sqlite3|sqlite-wal|sqlite-shm)$/i,
    description:
      'SQLite database or WAL/SHM file (holds state and HTLC preimages)',
  },
  {
    pattern: /(^|\/)packages\/solver\/data\/.+/i,
    description: 'Solver runtime state file in packages/solver/data/',
  },
  {
    pattern: /(^|\/)(broadcast|cache)\/.+/i,
    description: 'Foundry/contract broadcast or cache artifact directory',
  },
  {
    pattern: /(^|\/)target\/deploy\/.+/i,
    description: 'Anchor target deployment artifact directory',
  },
];

export interface HygieneViolation {
  file: string;
  line?: number;
  rule: string;
  message: string;
}

export function checkTrackedPath(filePath: string): HygieneViolation | null {
  // .env.example is explicitly allowed
  if (filePath === '.env.example' || filePath.endsWith('/.env.example')) {
    return null;
  }

  for (const { pattern, description } of FORBIDDEN_FILE_PATTERNS) {
    if (pattern.test(filePath)) {
      return {
        file: filePath,
        rule: 'FORBIDDEN_FILE_PATH',
        message: `Tracked file matches forbidden pattern: ${description}`,
      };
    }
  }

  return null;
}

export function checkTrackedContent(
  filePath: string,
  content: string,
): HygieneViolation[] {
  const violations: HygieneViolation[] = [];

  // Exclude non-source files, fixtures, docs, and test vectors where mock secrets are expected
  const isTestOrDoc =
    filePath.includes('test/') ||
    filePath.includes('.test.') ||
    filePath.includes('.spec.') ||
    filePath.includes('fixture') ||
    filePath.includes('mock') ||
    filePath.endsWith('.md') ||
    filePath.includes('eslint-rules/');

  if (isTestOrDoc) {
    return violations;
  }

  const lines = content.split('\n');

  // Match key assignments: PRIVATE_KEY = "...", privateKey: "...", wif: "..."
  const keyAssignRegex =
    /(?:PRIVATE_KEY|privateKey|secretKey|secret_key|WIF|wif)\s*[:=]\s*["']([0-9a-zA-Z]{32,66})["']/i;

  // Match Solana secret key arrays [1, 2, ..., 64]
  const solanaArrayRegex = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Check key assignments
    const keyMatch = keyAssignRegex.exec(line);
    if (keyMatch) {
      const val = keyMatch[1];
      if (val) {
        const isKnownSafe = KNOWN_SAFE_KEY_PREFIXES.some(
          (prefix) =>
            val.startsWith(prefix) ||
            val.startsWith('0x' + prefix) ||
            val.toLowerCase().startsWith(prefix.toLowerCase()) ||
            val.toLowerCase().startsWith('0x' + prefix.toLowerCase()),
        );

        if (!isKnownSafe) {
          violations.push({
            file: filePath,
            line: i + 1,
            rule: 'SUSPECTED_PRIVATE_KEY',
            message:
              'Suspected private key assignment found in tracked source file (value withheld for security)',
          });
        }
      }
    }

    // Check Solana key arrays
    if (solanaArrayRegex.test(line)) {
      violations.push({
        file: filePath,
        line: i + 1,
        rule: 'SUSPECTED_SOLANA_KEYPAIR',
        message:
          'Suspected Solana keypair byte array found in tracked source file (value withheld for security)',
      });
    }
  }

  return violations;
}

export function runHygieneCheck(
  rootDir: string = process.cwd(),
): HygieneViolation[] {
  const violations: HygieneViolation[] = [];

  // Get all files tracked by git
  let files: string[];
  try {
    const output = execSync('git ls-files', { cwd: rootDir, encoding: 'utf8' });
    files = output.trim().split('\n').filter(Boolean);
  } catch (err) {
    throw new Error(`Failed to run git ls-files: ${(err as Error).message}`, {
      cause: err,
    });
  }

  for (const file of files) {
    // 1. Path check
    const pathViolation = checkTrackedPath(file);
    if (pathViolation) {
      violations.push(pathViolation);
    }

    // 2. Content check (skip binaries and non-existent files)
    const fullPath = path.resolve(rootDir, file);
    if (!existsSync(fullPath)) continue;

    try {
      const content = readFileSync(fullPath, 'utf8');
      const contentViolations = checkTrackedContent(file, content);
      violations.push(...contentViolations);
    } catch {
      // Binary file or read error, skip
    }
  }

  return violations;
}

// CLI runner
if (process.argv[1] && process.argv[1].endsWith('check-repo-hygiene.ts')) {
  console.log('Running repository hygiene audit (pre-push gate)...');
  const violations = runHygieneCheck();

  if (violations.length > 0) {
    console.error(
      `\n❌ HYGIENE CHECK FAILED: Found ${violations.length} violation(s):\n`,
    );
    for (const v of violations) {
      const location = v.line ? `${v.file}:${v.line}` : v.file;
      console.error(`  - [${v.rule}] ${location}: ${v.message}`);
    }
    console.error(
      '\nRemediation: Untrack forbidden files with `git rm --cached <file>` and verify .gitignore.\nNever commit private keys, mnemonics, WIFs, or runtime databases.',
    );
    process.exit(1);
  }

  console.log(
    '✓ Repository hygiene audit passed: zero forbidden files or credentials tracked.',
  );
  process.exit(0);
}
