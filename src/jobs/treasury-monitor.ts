import { registerConfiguredTreasury } from '../app/bootstrap/register-configured-treasury.js';
import { recordHeartbeat } from '../app/health/record-heartbeat.js';
import { checkTreasuryBalance } from '../app/treasury/check-treasury-balance.js';
import { loadConfig } from '../config/index.js';
import { loadDotEnvFile } from '../config/load-dotenv.js';
import { buildContainer, type Container } from '../container.js';
import { describeUnknownError, isChainBankError } from '../domain/errors.js';

const SERVICE_ROLE = 'treasury-monitor';

/**
 * Daily read-only treasury check.
 *
 * Runs as a Render Cron Job with no signing credentials: it reads a balance,
 * records the observation, and exits. Alert emails arrive in Phase 3; this
 * phase establishes that the schedule, the shared database, and the chain read
 * all work.
 */
async function run(container: Container, operationId: string): Promise<void> {
  const { config, logger } = container;

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

  const result = await checkTreasuryBalance(
    {
      treasuries: container.repositories.treasuries,
      balanceObservations: container.repositories.balanceObservations,
      balanceReader: container.balanceReader,
      auditEvents: container.repositories.auditEvents,
    },
    {
      treasuryId: treasury.id,
      role: 'cron-treasury-monitor',
      operationId,
      actor: { type: 'cron', id: SERVICE_ROLE },
    },
  );

  await recordHeartbeat(
    { serviceHeartbeats: container.repositories.serviceHeartbeats, clock: container.clock },
    {
      serviceRole: SERVICE_ROLE,
      operationId,
      detail: { event: 'run', outcome: result.reading.kind, treasuryId: treasury.id },
    },
  );

  if (result.reading.kind === 'unavailable') {
    // An unreadable treasury is a failed run. Exiting non-zero is what makes
    // the platform surface it instead of reporting a silent success.
    throw new Error(`Treasury balance could not be read: ${result.reading.errorCode}`);
  }

  logger.info(
    {
      operationId,
      treasuryId: treasury.id,
      status: result.treasury.status,
      balanceWei: result.reading.balanceWei.toString(),
      blockNumber: result.reading.blockNumber.toString(),
    },
    'Treasury observation recorded',
  );
}

async function main(): Promise<void> {
  loadDotEnvFile();

  // The monitor loads configuration without the email or API sections, so it
  // never holds credentials it has no reason to use.
  const config = loadConfig({ serviceRole: 'treasury-monitor' });
  const container = buildContainer({ config });
  const operationId = container.idGenerator.next();
  const startedAt = Date.now();

  container.logger.info({ operationId }, 'Treasury monitor run started');

  try {
    await run(container, operationId);
    container.logger.info({ operationId, durationMs: Date.now() - startedAt }, 'Treasury monitor run succeeded');
  } catch (error) {
    container.logger.error(
      {
        operationId,
        durationMs: Date.now() - startedAt,
        code: isChainBankError(error) ? error.code : undefined,
        detail: describeUnknownError(error),
      },
      'Treasury monitor run failed',
    );
    process.exitCode = 1;
  } finally {
    // A cron process must release its pooled connections before exiting, or the
    // shared database slowly accumulates abandoned clients.
    await container.close();
  }
}

main().catch((error: unknown) => {
  const detail = isChainBankError(error) ? error.message : describeUnknownError(error);
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', service: 'chainbank', role: SERVICE_ROLE, message: 'Cron startup failed', detail })}\n`,
  );
  process.exitCode = 1;
});
