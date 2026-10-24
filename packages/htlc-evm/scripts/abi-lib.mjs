import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export const abiPath = join(packageRoot, 'abi.ts');
const artifactPath = join(
  packageRoot,
  'out',
  'FerryHTLC.sol',
  'FerryHTLC.json',
);

export async function generateAbiSource() {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const raw = `export const ferryHtlcAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;\nexport type FerryHtlcAbi = typeof ferryHtlcAbi;\n`;
  const options = (await prettier.resolveConfig(abiPath)) ?? {};
  return prettier.format(raw, { ...options, parser: 'typescript' });
}
