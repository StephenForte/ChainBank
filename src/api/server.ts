import { loadConfig } from '../config/index.js';
import { loadDotEnvFile } from '../config/load-dotenv.js';
import { buildContainer } from '../container.js';
import {
  registerConfiguredTreasuries,
  requireRegisteredChain,
  summarizeRegisteredTreasuries,
} from '../app/bootstrap/register-configured-treasury.js';
import { proveConfiguredChainIds } from '../app/health/prove-configured-chain-ids.js';
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
    // C28: a wrong-chain RPC refuses startup before listen, so no request can
    // reach a signer. An unreadable RPC is not that failure.
    await proveConfiguredChainIds(container.chainAdapters, logger);
    const treasuries = await registerConfiguredTreasuries(
      { chains: container.repositories.chains, treasuries: container.repositories.treasuries },
      config,
    );
    const registeredChains = summarizeRegisteredTreasuries(treasuries);
    const defaultChain = requireRegisteredChain(treasuries, config.defaultChainId);

    await recordHeartbeat(
      { serviceHeartbeats: container.repositories.serviceHeartbeats, clock: container.clock },
      {
        serviceRole: 'web',
        operationId: container.idGenerator.next(),
        detail: {
          event: 'startup',
          chainId: config.defaultChainId,
          chainIds: config.chains.map((chain) => chain.chainId),
          chains: registeredChains,
        },
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
        chainId: config.defaultChainId,
        chainIds: config.chains.map((chain) => chain.chainId),
        treasuryId: defaultChain.external.id,
        operationalTreasuryId: defaultChain.operational?.id,
        chains: registeredChains,
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
