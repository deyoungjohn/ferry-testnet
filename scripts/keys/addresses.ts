import { getDefaultEnvPath, getAddressesFromEnv, formatAddressesOutput } from './env.js';

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
  console.log(`Deriving addresses from: ${envPath}`);
  const addresses = getAddressesFromEnv(envPath);
  console.log(formatAddressesOutput(addresses));
}

main();
