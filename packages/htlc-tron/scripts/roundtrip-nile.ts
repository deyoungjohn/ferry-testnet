import { TronWeb } from 'tronweb';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const NILE_RPC = 'https://nile.trongrid.io';
const OFFICIAL_NILE_USDT = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf'; // Verified 6 decimals

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  const envPaths = [
    resolve(__dirname, '../../../.env.local'),
    resolve('/workspace/projects/ferry-app/.env.local'),
  ];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const lines = readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [k, ...v] = trimmed.split('=');
        if (k && v.length > 0) {
          env[k.trim()] = v.join('=').trim();
        }
      }
      break;
    }
  }
  return env;
}

async function main() {
  const env = loadEnv();
  const deployerKey = env.DEPLOYER_TRON_KEY;
  const solverKey = env.SOLVER_TRON_KEY;
  const userKey = env.USER_TRON_KEY;

  if (!deployerKey || !solverKey || !userKey) {
    console.error('Missing TRON keys in .env.local');
    process.exit(1);
  }

  const deployerTronWeb = new TronWeb({
    fullHost: NILE_RPC,
    privateKey: deployerKey,
  });
  const solverTronWeb = new TronWeb({
    fullHost: NILE_RPC,
    privateKey: solverKey,
  });
  const userTronWeb = new TronWeb({ fullHost: NILE_RPC, privateKey: userKey });

  const deployerAddress = deployerTronWeb.defaultAddress.base58;
  const solverAddress = solverTronWeb.defaultAddress.base58;
  const userAddress = userTronWeb.defaultAddress.base58;

  console.log('--- TRON Nile Addresses ---');
  console.log('Deployer:', deployerAddress);
  console.log('Solver:  ', solverAddress);
  console.log('User:    ', userAddress);

  // Check balances
  const deployerBalSun = await deployerTronWeb.trx.getBalance(deployerAddress);
  const solverBalSun = await solverTronWeb.trx.getBalance(solverAddress);
  const userBalSun = await userTronWeb.trx.getBalance(userAddress);

  console.log(
    `Balances: Deployer=${deployerBalSun / 1e6} TRX, Solver=${solverBalSun / 1e6} TRX, User=${userBalSun / 1e6} TRX`,
  );

  if (deployerBalSun < 50_000_000) {
    console.log(
      '\n[BLOCKED ON FUNDING] Deployer requires at least 50 TRX on Nile testnet.',
    );
    console.log(
      'Please fund addresses using https://nileex.io/join/getJoinPage or Telegram bot @tron_testnet_bot.',
    );
    console.log(
      'See lab/manual-checklists/L6-tron-funding.md for instructions.',
    );
    return;
  }

  // Load contract artifact
  const artifactPath = resolve(__dirname, '../build/contracts/FerryHTLC.json');
  if (!existsSync(artifactPath)) {
    throw new Error(
      'FerryHTLC artifact not found at ' +
        artifactPath +
        '. Run `pnpm compile` first.',
    );
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

  console.log('\nDeploying FerryHTLC on Nile...');
  const contractInstance = await deployerTronWeb.contract().new({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    feeLimit: 1_000_000_000,
    callValue: 0,
    userFeePercentage: 30,
  });

  const htlcAddress = contractInstance.address;
  console.log('FerryHTLC deployed at:', htlcAddress);

  // Verify USDT contract
  const usdtContract = await userTronWeb.contract().at(OFFICIAL_NILE_USDT);
  console.log(
    'Verified Nile USDT at:',
    usdtContract.address || OFFICIAL_NILE_USDT,
  );
}

main().catch((err) => {
  console.error('Error executing roundtrip:', err);
  process.exit(1);
});
