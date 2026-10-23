import { writeFileSync } from 'node:fs';
import { abiPath, generateAbiSource } from './abi-lib.mjs';

writeFileSync(abiPath, await generateAbiSource());
console.log(`wrote ${abiPath}`);
