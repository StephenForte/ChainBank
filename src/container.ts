import type {
  ApiCredentialRepository,
  AuditEventRepository,
  BalanceObservationRepository,
  BalanceReader,
  ChainRepository,
  EmailSender,
  ServiceHeartbeatRepository,
  TreasuryRepository,
} from './app/ports.js';
import type { ChainBankConfig } from './config/index.js';
import type { Clock, IdGenerator } from './domain/ports.js';
import { createDatabase, type DatabaseHandle } from './infrastructure/db/client.js';
import { createApiCredentialRepository } from './infrastructure/db/repositories/api-credential-repository.js';
import { createAuditEventRepository } from './infrastructure/db/repositories/audit-event-repository.js';
import { createBalanceObservationRepository } from './infrastructure/db/repositories/balance-observation-repository.js';
import { createChainRepository } from './infrastructure/db/repositories/chain-repository.js';
import { createServiceHeartbeatRepository } from './infrastructure/db/repositories/service-heartbeat-repository.js';
import { createTreasuryRepository } from './infrastructure/db/repositories/treasury-repository.js';
import { createLogOnlyEmailSender } from './infrastructure/email/log-only-email-sender.js';
import { createResendEmailSender } from './infrastructure/email/resend-email-sender.js';
import { createBalanceReader } from './infrastructure/evm/balance-reader.js';
import { createLogger, type Logger } from './observability/logger.js';
import { systemClock, uuidGenerator } from './shared/system-ports.js';

/**
 * Composition root.
 *
 * Every concrete adapter is constructed here and nowhere else, so the set of
 * capabilities a process holds is visible in one place. Notably, no signing
 * client is constructed, because none exists in this phase.
 */
export interface Container {
  readonly config: ChainBankConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly database: DatabaseHandle;
  readonly repositories: {
    readonly chains: ChainRepository;
    readonly treasuries: TreasuryRepository;
    readonly balanceObservations: BalanceObservationRepository;
    readonly apiCredentials: ApiCredentialRepository;
    readonly auditEvents: AuditEventRepository;
    readonly serviceHeartbeats: ServiceHeartbeatRepository;
  };
  readonly balanceReader: BalanceReader;
  /** Absent for roles that hold no email credentials. */
  readonly emailSender: EmailSender | undefined;
  close(): Promise<void>;
}

export interface BuildContainerOptions {
  readonly config: ChainBankConfig;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly logger?: Logger;
}

export function buildContainer(options: BuildContainerOptions): Container {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const idGenerator = options.idGenerator ?? uuidGenerator;

  const logger =
    options.logger ??
    createLogger({
      level: config.app.logLevel,
      serviceRole: config.app.serviceRole,
      environment: config.app.environment,
    });

  const database = createDatabase(config.database, logger);

  return {
    config,
    logger,
    clock,
    idGenerator,
    database,
    repositories: {
      chains: createChainRepository(database.db),
      treasuries: createTreasuryRepository(database.db),
      balanceObservations: createBalanceObservationRepository(database.db),
      apiCredentials: createApiCredentialRepository(database.db),
      auditEvents: createAuditEventRepository(database.db),
      serviceHeartbeats: createServiceHeartbeatRepository(database.db),
    },
    balanceReader: createBalanceReader({ chain: config.chain, clock, logger }),
    emailSender: buildEmailSender(config, logger),
    close: async () => {
      await database.close();
    },
  };
}

function buildEmailSender(config: ChainBankConfig, logger: Logger): EmailSender | undefined {
  if (config.email === undefined) {
    return undefined;
  }
  if (config.email.provider === 'log-only') {
    return createLogOnlyEmailSender(logger);
  }
  return createResendEmailSender({
    apiKey: config.email.apiKey,
    fromAddress: config.email.fromAddress,
    logger,
  });
}
