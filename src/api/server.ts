import { loadConfig } from '../config/index.js';
import { loadDotEnvFile } from '../config/load-dotenv.js';
import { buildContainer } from '../container.js';
import { registerConfiguredTreasury } from '../app/bootstrap/register-configured-treasury.js';
import { recordHeartbeat } from '../app/health/record-heartbeat.js';
import { describeUnknownError, isChainBankError } from '../domain/errors.js';
import { buildApp } from './app.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

async function main(): Promise<void> {
  loadDotEnvFile();

  const config = loadConfig({ serviceRole: 'web' });
  const container = buildContainer({ config });
  const { logger } = container;

  try {
    const treasury = await registerConfiguredTreasury(
      { chains: container.repositories.chains, treasuries: container.repositories.treasuries },
      {
        chain: {
          slug: config.chain.slug,
          chainId: config.chain.chainId,
          displayName: config.chain.displayName,
          nativeSymbol: config.chain.nativeSymbol,
          explorerBaseUrl: config.chain.explorerBaseUrl,
        },
        treasuryAddress: config.treasury.address.toLowerCase(),
        treasuryAddressDisplay: config.treasury.address,
        thresholds: {
          warningBalanceWei: config.treasury.warningBalanceWei,
          criticalBalanceWei: config.treasury.criticalBalanceWei,
          recoveryBalanceWei: config.treasury.recoveryBalanceWei,
          minimumReserveWei: config.treasury.minimumReserveWei,
        },
      },
    );

    await recordHeartbeat(
      { serviceHeartbeats: container.repositories.serviceHeartbeats, clock: container.clock },
      {
        serviceRole: 'web',
        operationId: container.idGenerator.next(),
        detail: { event: 'startup', chainId: config.chain.chainId },
      },
    );

    const app = await buildApp(container);

    for (const signal of SHUTDOWN_SIGNALS) {
      process.once(signal, () => {
        logger.info({ signal }, 'Shutdown signal received');
        void shutdown(app, container);
      });
    }

    await app.listen({ port: config.app.port, host: config.app.host });
    logger.info(
      {
        port: config.app.port,
        chainId: config.chain.chainId,
        treasuryId: treasury.id,
        fundingEnabled: config.isFundingEnabled,
      },
      'ChainBank web service started',
    );
  } catch (error) {
    logger.fatal({ detail: describeUnknownError(error) }, 'Web service failed to start');
    await container.close();
    process.exitCode = 1;
  }
}

async function shutdown(
  app: Awaited<ReturnType<typeof buildApp>>,
  container: { close: () => Promise<void> },
): Promise<void> {
  try {
    await app.close();
  } finally {
    await container.close();
  }
}

main().catch((error: unknown) => {
  // Configuration failures happen before a logger exists, so this is the one
  // place a plain structured write to stderr is correct.
  const detail = isChainBankError(error) ? error.message : describeUnknownError(error);
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', service: 'chainbank', role: 'web', message: 'Startup failed', detail })}\n`,
  );
  process.exitCode = 1;
});
