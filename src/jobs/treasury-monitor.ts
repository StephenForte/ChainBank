import { evaluateTreasuryAlerts } from '../app/alerts/evaluate-treasury-alerts.js';
import {
  chainOutcomesForDetail,
  isIsolatedChainRpcFailure,
  type ChainProcessingStatus,
  type ChainRunOutcome,
} from '../app/alerts/chain-run-outcome.js';
import {
  registerConfiguredTreasuries,
  requireRegisteredChain,
  summarizeRegisteredTreasuries,
} from '../app/bootstrap/register-configured-treasury.js';
import { proveConfiguredChainIds } from '../app/health/prove-configured-chain-ids.js';
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
 *
 * Each configured chain is isolated (C29). An unavailable read does not
 * evaluate alerts for that treasury — absence of a reading is not health —
 * and does not stop the other chains. After every chain has been attempted,
 * any chain that was not fully processed still throws, which is the process
 * exit signal Render pages on. Deleting that throw would make a dark chain
 * look like a successful run.
 */
export async function runTreasuryMonitor(container: Container, operationId: string): Promise<void> {
  const { config, logger } = container;

  if (container.emailSender === undefined || config.email === undefined) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      'treasury-monitor requires email configuration to deliver alert emails',
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  const registered = await registerConfiguredTreasuries(
    { chains: container.repositories.chains, treasuries: container.repositories.treasuries },
    config,
  );

  const chainOutcomes: ChainRunOutcome[] = [];

  for (const entry of registered.chains) {
    const treasuries =
      entry.operational === undefined ? [entry.external] : [entry.external, entry.operational];
    let observed = 0;
    let unavailable = 0;
    let errorCode: string | undefined;
    let reason: string | undefined;

    try {
      for (const treasury of treasuries) {
        const result = await checkTreasuryBalance(
          {
            treasuries: container.repositories.treasuries,
            chainAdapters: container.chainAdapters,
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
          observed += 1;
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
              treasuryKind: treasury.kind,
              chainId: entry.chainId,
              transition: alertResult.transition.kind,
              email: alertResult.email.kind,
            },
            'Treasury alert evaluation completed',
          );

          logger.info(
            {
              operationId,
              treasuryId: treasury.id,
              treasuryKind: treasury.kind,
              chainId: entry.chainId,
              status: result.treasury.status,
              balanceWei: result.reading.balanceWei.toString(),
              blockNumber: result.reading.blockNumber.toString(),
            },
            'Treasury observation recorded',
          );
        } else {
          unavailable += 1;
          errorCode = result.reading.errorCode;
          reason = result.reading.reason;
          logger.error(
            {
              event: 'treasury_monitor.chain_unavailable',
              operationId,
              treasuryId: treasury.id,
              treasuryKind: treasury.kind,
              chainId: entry.chainId,
              errorCode: result.reading.errorCode,
            },
            'Treasury balance could not be read',
          );
        }
      }
    } catch (error) {
      if (!isIsolatedChainRpcFailure(error)) {
        throw error;
      }
      unavailable += 1;
      errorCode = error.code;
      reason = error.message;
      logger.error(
        {
          event: 'treasury_monitor.chain_unavailable',
          operationId,
          chainId: entry.chainId,
          errorCode: error.code,
        },
        'Chain could not be read; continuing other chains',
      );
    }

    let status: ChainProcessingStatus = 'processed';
    if (unavailable > 0) {
      status = observed === 0 ? 'unavailable' : 'processed-with-failures';
    }
    chainOutcomes.push({
      chainId: entry.chainId,
      status,
      errorCode,
      reason,
    });
  }

  const anyUnprocessed = chainOutcomes.some((outcome) => outcome.status !== 'processed');
  const defaultChain = requireRegisteredChain(registered, config.defaultChainId);
  await recordHeartbeat(
    { serviceHeartbeats: container.repositories.serviceHeartbeats, clock: container.clock },
    {
      serviceRole: SERVICE_ROLE,
      operationId,
      detail: {
        event: 'run',
        treasuryId: defaultChain.external.id,
        operationalTreasuryId: defaultChain.operational?.id,
        chains: summarizeRegisteredTreasuries(registered),
        outcome: anyUnprocessed ? 'unavailable' : 'observed',
        chainOutcomes: chainOutcomesForDetail(chainOutcomes),
      },
    },
  );

  if (anyUnprocessed) {
    throw new Error('One or more treasury balances could not be read');
  }
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
    // C28: a mismatched RPC fails this process before any balance is recorded.
    // Unreachable is a separate outcome and does not change the run's own
    // per-treasury availability handling.
    await proveConfiguredChainIds(container.chainAdapters, container.logger);
    await runTreasuryMonitor(container, operationId);
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
