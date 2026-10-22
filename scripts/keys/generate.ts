import { getDefaultEnvPath, generateMissingKeys, formatAddressesOutput } from './env.js';

function getEnvFileArg(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--env-file');
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return getDefaultEnvPath();
}

function main() {
  const envPath = getEnvFileArg();
  console.log(`Key generation target: ${envPath}`);

  const result = generateMissingKeys(envPath);

  if (result.skippedKeys.length > 0) {
    console.log(`Skipped existing keys (${result.skippedKeys.length}):`);
    for (const key of result.skippedKeys) {
      console.log(`  - ${key} (already present, not overwritten)`);
    }
  }

  if (result.generatedKeys.length > 0) {
    console.log(`Generated new keys (${result.generatedKeys.length}):`);
    for (const key of result.generatedKeys) {
      console.log(`  - ${key} (created and saved with mode 600)`);
    }
  } else {
    console.log('No new keys generated; all required keys are already present.');
  }

  console.log('\nDerived public addresses (addresses only, secrets never displayed):');
  console.log(formatAddressesOutput(result.addresses));
}

main();
