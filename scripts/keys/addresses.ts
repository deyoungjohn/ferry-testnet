import {
  getDefaultEnvPath,
  getAddressesFromEnv,
  formatAddressesOutput,
} from './env.js';

function getEnvFileArg(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--env-file');
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1]!;
  }
  return getDefaultEnvPath();
}

function main() {
  const envPath = getEnvFileArg();
  console.log(`Deriving addresses from: ${envPath}`);
  const result = getAddressesFromEnv(envPath);
  console.log(formatAddressesOutput(result.addresses));

  if (result.hasInvalidKeys) {
    console.error(
      `\nError: Found invalid key(s) in env file: ${result.invalidKeys.join(', ')}`,
    );
    process.exit(1);
  }
}

main();
