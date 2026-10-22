import { getDefaultEnvPath, getAddressesFromEnv, parseEnvFile } from '../keys/env.js';
import { BCH_KEY_ROLES, EVM_KEY_ROLES } from '../keys/types.js';
import { ElectrumClient } from './electrum.js';
import { EvmClient, BASE_SEPOLIA_USDC } from './evm.js';

function getEnvFileArg(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--env-file');
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return getDefaultEnvPath();
}

async function main() {
  const envPath = getEnvFileArg();
  const envVars = parseEnvFile(envPath);

  const bchElectrumUrl =
    envVars.BCH_CHIPNET_ELECTRUM_URLS?.split(',')[0]?.trim() ||
    'wss://chipnet.imaginary.cash:50004';
  const baseRpcUrl =
    envVars.BASE_RPC_URL?.trim() ||
    'https://sepolia.base.org';
  const usdcAddress =
    (envVars.USDC_ADDRESS?.trim() as `0x${string}`) ||
    BASE_SEPOLIA_USDC;

  console.log('===============================================================');
  console.log(' Ferry Lab — Testnet Balances');
  console.log('===============================================================');
  console.log(`Env source:    ${envPath}`);
  console.log(`BCH Fulcrum:   ${bchElectrumUrl}`);
  console.log(`Base RPC:      ${baseRpcUrl}`);
  console.log(`Base USDC:     ${usdcAddress}`);
  console.log('---------------------------------------------------------------\n');

  const addresses = getAddressesFromEnv(envPath);

  // 1. BCH Chipnet Balances
  console.log('=== Bitcoin Cash Chipnet Balances ===');
  const electrum = new ElectrumClient(bchElectrumUrl);
  try {
    await electrum.connect();
    for (const role of BCH_KEY_ROLES) {
      const addrInfo = addresses.bch[role];
      console.log(`\nRole: ${role}`);
      if (!addrInfo) {
        console.log('  [Address not derived / key not found in env]');
        continue;
      }
      console.log(`  P2PKH (plain):       ${addrInfo.plain}`);
      console.log(`  P2PKH (token-aware): ${addrInfo.tokenAware}`);

      try {
        const bal = await electrum.getBalanceAndTokens(addrInfo.plain);
        console.log(`  Balance:             ${bal.totalBch} tBCH (${bal.totalSats.toLocaleString()} sats)`);
        if (bal.unconfirmedSats !== 0) {
          console.log(`    (Confirmed: ${bal.confirmedSats} sats, Unconfirmed: ${bal.unconfirmedSats} sats)`);
        }
        if (bal.tokens.length === 0) {
          console.log('  CashTokens:          None');
        } else {
          console.log('  CashTokens:');
          for (const token of bal.tokens) {
            console.log(`    Category: ${token.category} | Amount: ${token.amount} | NFTs: ${token.nftCount}`);
          }
        }
      } catch (err: any) {
        console.log(`  Error querying balance: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error(`Failed to connect to Electrum server ${bchElectrumUrl}: ${err.message}`);
  } finally {
    electrum.close();
  }

  // 2. Base Sepolia EVM Balances
  console.log('\n=== Base Sepolia Balances ===');
  const evm = new EvmClient(baseRpcUrl, usdcAddress);
  for (const role of EVM_KEY_ROLES) {
    const addr = addresses.evm[role];
    console.log(`\nRole: ${role}`);
    if (!addr) {
      console.log('  [Address not derived / key not found in env]');
      continue;
    }
    console.log(`  Address:  ${addr}`);
    try {
      const bal = await evm.getBalances(addr as `0x${string}`);
      console.log(`  ETH:      ${bal.ethFormatted} ETH (${bal.ethWei.toString()} wei)`);
      console.log(`  USDC:     ${bal.usdcFormatted} USDC`);
    } catch (err: any) {
      console.log(`  Error querying EVM balances: ${err.message}`);
    }
  }

  console.log('\n===============================================================');
}

main().catch((err) => {
  console.error('Fatal balances error:', err);
  process.exit(1);
});
