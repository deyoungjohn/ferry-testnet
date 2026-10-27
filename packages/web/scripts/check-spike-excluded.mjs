import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const marker = 'FERRY_WALLET_EXTENSION_SPIKE_MARKER';
const offenders = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!/\.(?:html|js|css)$/.test(entry.name)) continue;
    const contents = await readFile(path, 'utf8');
    if (contents.includes(marker)) offenders.push(path);
  }
}

try {
  await walk(dist);
} catch (cause) {
  process.stderr.write(
    `Could not inspect the production bundle: ${
      cause instanceof Error ? cause.message : String(cause)
    }\n`,
  );
  process.exitCode = 1;
  process.exit();
}

if (offenders.length > 0) {
  process.stderr.write(
    `The wallet-extension spike reached the production bundle:\n${offenders
      .map((path) => `  ${path}`)
      .join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    'Wallet-extension spike excluded from production bundle.\n',
  );
}
