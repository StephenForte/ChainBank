import { evaluateTreasuryAlerts } from '../app/alerts/evaluate-treasury-alerts.js';
import { registerConfiguredTreasury } from '../app/bootstrap/register-configured-treasury.js';
import { recordHeartbeat } from '../app/health/record-heartbeat.js';
import { checkTreasuryBalance } from '../app/treasury/check-treasury-balance.js';
import { loadConfig } from '../config/index.js';
import { loadDotEnvFile } from '../config/load-dotenv.js';
import { buildContainer, type Container } from '../container.js';
import { ChainBankError, describeUnknownError, isChainBankError } from '../domain/errors.js';

const SERVICE_ROLE = 'treasury-monitor';

/**
 * Daily read-only treasury check with alert evaluation.
 *
 * Runs as a Render Cron Job with no signing credentials: it reads a balance,
 * records the observation, evaluates alert transitions, and sends at most the
 * email the transition dictates. Never constructs a treasury signer.
 */
async function run(container: Container, operationId: string): Promise<void> {
  const { config, logger } = container;

  if (container.emailSender === undefined || config.email === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'treasury-monitor requires email configuration to deliver alert emails',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

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
      balanceReader: container.balanceReader,
      operatorMutations: container.operatorMutations,
    },
    {
      treasuryId: treasury.id,
      role: 'cron-treasury-monitor',
      operationId,
      actor: { type: 'cron', id: SERVICE_ROLE },
    },
  );

  if (result.reading.kind === 'observed') {
    const alertResult = await evaluateTreasuryAlerts(
      {
        alerts: container.repositories.alerts,
        emailSender: container.emailSender,
        auditEvents: container.repositories.auditEvents,
        clock: container.clock,
      },
      {
        treasury: result.treasury,
        balanceWei: result.reading.balanceWei,
        reminderIntervalMs: config.alerts.reminderIntervalMs,
        operatorRecipients: config.email.operatorRecipients,
        dashboardBaseUrl: config.app.publicBaseUrl,
        environment: config.app.environment,
        operationId,
        actor: { type: 'cron', id: SERVICE_ROLE },
      },
    );

    logger.info(
      {
        operationId,
        treasuryId: treasury.id,
        transition: alertResult.transition.kind,
        email: alertResult.email.kind,
      },
      'Treasury alert evaluation completed',
    );
  }

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

  // Monitor loads email settings for alert delivery but never receives
  // TREASURY_PRIVATE_KEY (stripped before parse for non-signing roles).
  const config = loadConfig({ serviceRole: 'treasury-monitor' });
  const container = buildContainer({ config });
  const operationId = container.idGenerator.next();
  const startedAt = Date.now();

  container.logger.info({ operationId }, 'Treasury monitor run started');

  try {
    await run(container, operationId);
    container.logger.info(
      { operationId, durationMs: Date.now() - startedAt },
      'Treasury monitor run succeeded',
    );
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
