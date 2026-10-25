import pino from 'pino';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmChainAdapter } from '@ferry/chain-evm';
import { loadConfigFromEnv } from './config.js';
import { SolverDatabase } from './db/database.js';
import { BchQuorumClient } from './bch/quorum-client.js';
import { SolverEngine } from './engine/runner.js';
import { buildServer } from './api/server.js';
import { TestnetStubPriceSource } from './pricing/price-source.js';

async function main(): Promise<void> {
  const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      paths: [
        'req.body.secret',
        'body.secret',
        'secret',
        'solverEvmPrivateKey',
        'solverBchWif',
      ],
      censor: '[REDACTED]',
    },
  });

  logger.info('Starting Ferryman solver daemon...');

  // 1. Load config
  const config = loadConfigFromEnv(process.env);
  logger.info(
    {
      network: config.network,
      port: config.port,
      host: config.host,
      baseChainId: config.baseChainId,
      htlcAddress: config.baseHtlcAddress,
    },
    'Configuration loaded',
  );

  // 2. Open DB
  const db = new SolverDatabase(config.dbPath);
  logger.info({ dbPath: config.dbPath }, 'SQLite action database opened');

  // 3. Connect to EVM adapter
  const solverAccount = privateKeyToAccount(
    config.solverEvmPrivateKey as `0x${string}`,
  );
  const publicClient = createPublicClient({
    transport: http(config.baseRpcUrl),
  });
  const walletClient = createWalletClient({
    account: solverAccount,
    transport: http(config.baseRpcUrl),
  });

  const evmAdapter = new EvmChainAdapter({
    chain: 'base',
    chainId: config.baseChainId,
    rpcUrl: config.baseRpcUrl,
    htlcAddress: config.baseHtlcAddress as `0x${string}`,
    usdcAddress: config.baseUsdcAddress as `0x${string}`,
    confirmations: config.evmConfs,
    client: publicClient,
    walletClient,
  });

  // 4. Connect to BCH Quorum client
  const electrumUrls = config.bchElectrumUrls
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  const bchClient = new BchQuorumClient(electrumUrls);
  await bchClient.connect();
  logger.info(
    { urls: electrumUrls, quorum: bchClient.getQuorumStatus() },
    'Connected to BCH Fulcrum quorum',
  );

  if (!config.solverBchWif) {
    logger.error('SOLVER_BCH_WIF is required to run the solver daemon');
    process.exit(1);
  }

  // 5. Initialize Engine
  const engine = new SolverEngine(
    db,
    evmAdapter,
    bchClient,
    config.solverEvmPrivateKey as `0x${string}`,
    config.solverBchWif,
    logger,
  );
  await engine.start();
  logger.info('Solver engine started with chain watchers active');

  // 6. Build and start API server
  const priceSource = new TestnetStubPriceSource(logger);
  const app = buildServer({
    config,
    db,
    evmAdapter,
    bchClient,
    engine,
    priceSource,
    logger,
  });

  await app.listen({ port: config.port, host: config.host });
  logger.info(
    { port: config.port, host: config.host },
    'Ferryman HTTP API listening',
  );

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal; closing Ferryman...');
    engine.stop();
    await app.close();
    bchClient.close();
    db.close();
    logger.info('Clean shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal solver startup error:', err);
  process.exit(1);
});
