import { readFileSync } from 'node:fs';
import { abiPath, generateAbiSource } from './abi-lib.mjs';

const expected = await generateAbiSource();
const actual = readFileSync(abiPath, 'utf8');

if (actual !== expected) {
  console.error('abi.ts is stale; run pnpm --filter @ferry/htlc-evm abi');
  process.exit(1);
}

console.log('abi.ts is in sync');
